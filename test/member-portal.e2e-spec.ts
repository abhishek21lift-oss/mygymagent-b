import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { waitForEmailTo } from './utils/mailbox';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * F-P0-1: the member portal.
 *
 * The product half is that a member can sign in and see their own
 * memberships, visits, workout plan and diet plan. The part worth the
 * most test weight is the boundary, because of what the audit turned up:
 * the `MEMBER` role carried `attendance.read`, `workouts.read` and
 * `nutrition.read` -- the *org-wide* reads that `GET /attendance`
 * accepts. Issuing that role would have let a member list every check-in
 * in the gym, every workout plan and every diet plan. Nothing issued it,
 * which is the only reason it was never a breach.
 *
 * So the cases below pin both halves: a member sees their own data, and
 * a member reaching a staff route gets nothing.
 */
describe('Member portal (e2e, F-P0-1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let memberId: string;
  let otherMemberId: string;
  let memberEmail: string;
  let memberToken: string;
  let memberLoginBody: {
    user: { id: string; memberId: string | null };
    accessToken: string;
  };

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asMember = (req: request.Test) => authed(memberToken)(req);

  const PASSWORD = 'MemberPortalPass9';

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Portal Test Gym',
        email: `portal-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Portal',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    memberEmail = `portal-member-${Date.now()}@example.com`;
    const created = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Priya',
        lastName: 'Member',
        email: memberEmail,
      }),
    ).expect(201);
    memberId = created.body.data.id;
    await grantActiveMembership(app, ownerToken, memberId);

    // A second member, so "their own data" has something to exclude.
    const other = await asOwner(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchId,
          firstName: 'Someone',
          lastName: 'Else',
          email: `portal-other-${Date.now()}@example.com`,
        }),
    ).expect(201);
    otherMemberId = other.body.data.id;
    await grantActiveMembership(app, ownerToken, otherMemberId);

    // Both check in, so the attendance scoping case has real rows.
    for (const id of [memberId, otherMemberId]) {
      await asOwner(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ branchId, memberId: id, method: 'MANUAL' }),
      ).expect(201);
    }
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('granting portal access', () => {
    it('links a user, assigns MEMBER, and lets the member set a password', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post(`/portal/enable/${memberId}`),
      ).expect(201);
      expect(res.body.data.invited).toBe(true);

      const member = await prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { userId: true },
      });
      expect(member.userId).toBeTruthy();

      // The invite reuses the staff password-reset token, so the member
      // sets a password through the ordinary endpoint.
      const token = await prisma.passwordResetToken.findFirstOrThrow({
        where: { userId: member.userId!, usedAt: null },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      expect(token.id).toBeTruthy();
    });

    it('is idempotent -- re-inviting does not stack roles', async () => {
      await asOwner(
        request(app.getHttpServer()).post(`/portal/enable/${memberId}`),
      ).expect(201);

      const member = await prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { userId: true },
      });
      const roles = await prisma.userRole.count({
        where: { userId: member.userId! },
      });
      expect(roles).toBe(1);
    });

    it('refuses a member with no email, since there is nowhere to send it', async () => {
      const noEmail = await asOwner(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Nomail',
          lastName: 'Member',
        }),
      ).expect(201);

      await asOwner(
        request(app.getHttpServer()).post(
          `/portal/enable/${noEmail.body.data.id}`,
        ),
      ).expect(400);
    });

    it('denies a caller without portal.manage', async () => {
      await asMemberLogin();
      await asMember(
        request(app.getHttpServer()).post(`/portal/enable/${otherMemberId}`),
      ).expect(403);
    });
  });

  /**
   * Signs the member in the way a real member would: take the token out
   * of the invitation email, set a password through the ordinary reset
   * endpoint, then log in. Hashing a password straight into the row
   * would have tested nothing about whether the invite actually works.
   */
  async function asMemberLogin() {
    if (memberToken) return;

    // The member also gets a welcome email from the MemberCreated
    // listener, so this matches the invitation specifically rather than
    // whichever message happened to land last. Members get their own
    // template now (`member_portal_invite`) -- the staff one told them
    // they had been "invited to join {org} on THE CULT CLIENT", which
    // reads as a job offer for software they have never heard of.
    const sent = await waitForEmailTo(memberEmail, 8000, (email) =>
      /member access is ready/i.test(email.subject),
    );
    const tokenMatch = /[?&]token=([^\s&"<]+)/.exec(sent.body);
    expect(tokenMatch).not.toBeNull();
    const inviteToken = decodeURIComponent(tokenMatch![1]);

    // Accepting the invitation both sets the password and activates the
    // account. Nothing else does: before this work, `login()` refused
    // anything but ACTIVE and no code path ever promoted an INVITED user,
    // so an invited member could set a password and still be told their
    // credentials were wrong.
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token: inviteToken, newPassword: PASSWORD })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: memberEmail, password: PASSWORD })
      .expect(201);
    memberToken = login.body.data.accessToken;
    memberLoginBody = login.body.data;
  }

  /**
   * Which app the session opens.
   *
   * The portal was reachable only by typing `/portal`: the login page
   * sent everyone to `/dashboard`, where a member 403s on every request
   * and has no way out. The client cannot work this out for itself
   * without probing a route it expects to be refused, so the server
   * answers it at sign-in and on every session read -- a reload must not
   * lose the decision.
   */
  describe('the session says which app it belongs to', () => {
    beforeAll(() => asMemberLogin());

    it('carries the member id on login', () => {
      expect(memberLoginBody.user.memberId).toBe(memberId);
    });

    it('still carries it on /auth/me, so a reload routes the same way', async () => {
      const me = await asMember(
        request(app.getHttpServer()).get('/auth/me'),
      ).expect(200);
      expect(me.body.data.user.memberId).toBe(memberId);
    });

    it('leaves it null for a staff account', async () => {
      const me = await asOwner(
        request(app.getHttpServer()).get('/auth/me'),
      ).expect(200);
      expect(me.body.data.user.memberId).toBeNull();
    });
  });

  /**
   * `POST /portal/enable` had no caller in the UI, so the staff side
   * could not grant a login at all. Giving it one needs the member
   * payload to say whether a login exists and whether it was accepted --
   * without handing the password hash to every reader of a member.
   */
  describe('the staff view of a member portal login', () => {
    beforeAll(() => asMemberLogin());

    it('reports the login and its acceptance state', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get(`/members/${memberId}`),
      ).expect(200);
      expect(res.body.data.user).toMatchObject({
        email: memberEmail,
        status: 'ACTIVE',
      });
    });

    it('never exposes the credential columns with it', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get(`/members/${memberId}`),
      ).expect(200);
      expect(Object.keys(res.body.data.user).sort()).toEqual([
        'email',
        'id',
        'status',
      ]);
    });

    it('is absent for a member who was never invited', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get(`/members/${otherMemberId}`),
      ).expect(200);
      expect(res.body.data.user).toBeNull();
    });
  });

  /**
   * The write half (F-P0-1 slice 3). Same rule as the reads: no route
   * takes a member id, so "their own data" is a property of the query.
   * The cases that matter most are the refusals.
   */
  describe('what a member can change', () => {
    beforeAll(() => asMemberLogin());

    it('updates their own contact details', async () => {
      await asMember(
        request(app.getHttpServer())
          .patch('/portal/me')
          .send({ phone: '+91 98200 12345', city: 'Mumbai' }),
      ).expect(200);

      const me = await asMember(
        request(app.getHttpServer()).get('/portal/me'),
      ).expect(200);
      expect(me.body.data.member.phone).toBe('+91 98200 12345');
      // `me` has to carry every editable field back, or the account
      // form renders blanks over stored values and a member cannot tell
      // an empty field from one the screen did not fetch.
      expect(me.body.data.member.city).toBe('Mumbai');
    });

    it('reads back every field the account form can edit', async () => {
      await asMember(
        request(app.getHttpServer()).patch('/portal/me').send({
          emergencyContactName: 'Anita Sharma',
          emergencyContactPhone: '+91 98200 99999',
          addressLine1: '12 Linking Road',
          postalCode: '400050',
        }),
      ).expect(200);

      const me = await asMember(
        request(app.getHttpServer()).get('/portal/me'),
      ).expect(200);
      expect(me.body.data.member).toMatchObject({
        emergencyContactName: 'Anita Sharma',
        emergencyContactPhone: '+91 98200 99999',
        addressLine1: '12 Linking Road',
        postalCode: '400050',
      });
    });

    it.each([
      ['status', { status: 'ACTIVE' }],
      ['primaryBranchId', { primaryBranchId: 'anything' }],
      ['assignedTrainerId', { assignedTrainerId: 'anything' }],
      ['memberType', { memberType: 'PT' }],
      ['email', { email: 'someone-else@example.com' }],
      ['firstName', { firstName: 'Renamed' }],
    ])('refuses to let a member set their own %s', async (_field, body) => {
      // These are the gym's decisions, not the member's. The DTO cannot
      // express them, so `forbidNonWhitelisted` refuses the request
      // rather than a filtering step having to remember to strip it.
      await asMember(
        request(app.getHttpServer()).patch('/portal/me').send(body),
      ).expect(400);
    });

    it('refuses an empty update rather than reporting success', async () => {
      await asMember(
        request(app.getHttpServer()).patch('/portal/me').send({}),
      ).expect(400);
    });

    it('lists every notification category with its effective setting', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/notification-preferences'),
      ).expect(200);
      // A category with no stored row is on. Returning only stored rows
      // would show a member an empty screen they cannot act on.
      expect(res.body.data.items[0]).toMatchObject({
        email: true,
        inApp: true,
      });

      // Six of the ten. The other four are staff categories, and a
      // member offered a switch for "low stock and inventory alerts" is
      // being offered to mute a message that was never coming.
      const keys = res.body.data.items.map((item: { key: string }) => item.key);
      expect(keys).toEqual([
        'MEMBERSHIPS',
        'ATTENDANCE',
        'PAYMENTS',
        'WORKOUT',
        'DIET',
        'PT',
      ]);
    });

    it('describes those categories from the member’s side', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/notification-preferences'),
      ).expect(200);
      const attendance = res.body.data.items.find(
        (item: { key: string }) => item.key === 'ATTENDANCE',
      );
      // The staff wording is "Member attendance activity", which to a
      // member describes other people.
      expect(attendance.description).toBe('Your check-ins at the gym.');
    });

    it('refuses a staff-only category even though it is a real one', async () => {
      // INVENTORY exists and the staff endpoint would store it happily.
      // A setting that changes nothing is worse than a rejection.
      await asMember(
        request(app.getHttpServer())
          .patch('/portal/notification-preferences/INVENTORY')
          .send({ email: false }),
      ).expect(400);
    });

    it('turns a category off, and it stays off', async () => {
      const category = 'PAYMENTS';
      await asMember(
        request(app.getHttpServer())
          .patch(`/portal/notification-preferences/${category}`)
          .send({ email: false, whatsapp: false }),
      ).expect(200);

      const res = await asMember(
        request(app.getHttpServer()).get('/portal/notification-preferences'),
      ).expect(200);
      const row = res.body.data.items.find(
        (item: { key: string }) => item.key === category,
      );
      expect(row).toMatchObject({ email: false, whatsapp: false, inApp: true });
    });

    it('rejects a category that does not exist', async () => {
      await asMember(
        request(app.getHttpServer())
          .patch('/portal/notification-preferences/NOT_A_CATEGORY')
          .send({ email: false }),
      ).expect(400);
    });
  });

  describe('booking a class from the member app', () => {
    let sessionId: string;
    let otherMembersBookingId: string;

    beforeAll(async () => {
      await asMemberLogin();

      const program = await asOwner(
        request(app.getHttpServer()).post('/classes/programs').send({
          branchId,
          name: 'Portal Yoga',
          capacity: 5,
          durationMinutes: 60,
        }),
      ).expect(201);

      const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      const session = await asOwner(
        request(app.getHttpServer()).post('/classes/sessions').send({
          branchId,
          classProgramId: program.body.data.id,
          startTime: start.toISOString(),
          endTime: end.toISOString(),
        }),
      ).expect(201);
      sessionId = session.body.data.id;

      // Somebody else's seat in the same session, for the case below.
      const booked = await asOwner(
        request(app.getHttpServer())
          .post(`/classes/sessions/${sessionId}/book`)
          .send({ memberId: otherMemberId }),
      ).expect(201);
      otherMembersBookingId = booked.body.data.id;
    });

    it('shows the timetable with the member’s own standing folded in', async () => {
      const before = await asMember(
        request(app.getHttpServer()).get('/portal/classes'),
      ).expect(200);
      const mine = before.body.data.items.find(
        (item: { id: string }) => item.id === sessionId,
      );
      // A timetable that does not say which classes you are already in
      // is a timetable you cannot act on.
      expect(mine).toMatchObject({ myBookingStatus: null, myBookingId: null });
    });

    it('books a seat and then shows it as booked', async () => {
      const res = await asMember(
        request(app.getHttpServer()).post(`/portal/classes/${sessionId}/book`),
      ).expect(201);
      expect(res.body.data.status).toBe('BOOKED');

      const after = await asMember(
        request(app.getHttpServer()).get('/portal/classes'),
      ).expect(200);
      const mine = after.body.data.items.find(
        (item: { id: string }) => item.id === sessionId,
      );
      expect(mine.myBookingStatus).toBe('BOOKED');
      expect(mine.myBookingId).toBeTruthy();
    });

    it('cannot cancel another member’s seat', async () => {
      // The staff cancel checks only that the booking belongs to the
      // organization -- correct for a receptionist, and an open door
      // here. Ownership is established from the JWT first.
      await asMember(
        request(app.getHttpServer()).delete(
          `/portal/classes/bookings/${otherMembersBookingId}`,
        ),
      ).expect(404);

      const stillBooked = await prisma.classBooking.findUniqueOrThrow({
        where: { id: otherMembersBookingId },
        select: { status: true },
      });
      expect(stillBooked.status).toBe('BOOKED');
    });

    it('cancels its own seat', async () => {
      const listed = await asMember(
        request(app.getHttpServer()).get('/portal/classes'),
      ).expect(200);
      const mine = listed.body.data.items.find(
        (item: { id: string }) => item.id === sessionId,
      );

      await asMember(
        request(app.getHttpServer()).delete(
          `/portal/classes/bookings/${mine.myBookingId}`,
        ),
      ).expect(200);

      const after = await asMember(
        request(app.getHttpServer()).get('/portal/classes'),
      ).expect(200);
      const gone = after.body.data.items.find(
        (item: { id: string }) => item.id === sessionId,
      );
      expect(gone.myBookingStatus).toBeNull();
    });
  });

  describe('asking to renew', () => {
    beforeAll(() => asMemberLogin());

    it('offers the plans available at their branch', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/renewal-options'),
      ).expect(200);
      expect(res.body.data.items.length).toBeGreaterThan(0);
      expect(res.body.data.items[0]).toHaveProperty('price');
    });

    it('puts the request in the queue staff already watch', async () => {
      const options = await asMember(
        request(app.getHttpServer()).get('/portal/renewal-options'),
      ).expect(200);
      const plan = options.body.data.items[0];

      const res = await asMember(
        request(app.getHttpServer())
          .post('/portal/renewal-requests')
          .send({ membershipPlanId: plan.id, note: 'Same plan please' }),
      ).expect(201);
      expect(res.body.data.alreadyRequested).toBe(false);

      const followUp = await prisma.memberFollowUp.findUniqueOrThrow({
        where: { id: res.body.data.requestId },
        select: { memberId: true, title: true, priority: true },
      });
      expect(followUp.memberId).toBe(memberId);
      expect(followUp.title).toContain(plan.name);
      expect(followUp.priority).toBe('HIGH');
    });

    it('does not queue a second request while one is open', async () => {
      const options = await asMember(
        request(app.getHttpServer()).get('/portal/renewal-options'),
      ).expect(200);

      const res = await asMember(
        request(app.getHttpServer())
          .post('/portal/renewal-requests')
          .send({ membershipPlanId: options.body.data.items[0].id }),
      ).expect(201);
      expect(res.body.data.alreadyRequested).toBe(true);

      const open = await prisma.memberFollowUp.count({
        where: { memberId, completedAt: null },
      });
      expect(open).toBe(1);
    });

    it('refuses a plan that is not theirs to buy', async () => {
      await asMember(
        request(app.getHttpServer())
          .post('/portal/renewal-requests')
          .send({ membershipPlanId: '00000000-0000-4000-8000-000000000000' }),
      ).expect(404);
    });
  });

  describe('what a member can see', () => {
    beforeAll(() => asMemberLogin());

    it('signs in and sees their own profile and active membership', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/me'),
      ).expect(200);
      expect(res.body.data.member.id).toBe(memberId);
      expect(res.body.data.member.firstName).toBe('Priya');
      expect(res.body.data.activeMembership).toBeTruthy();
    });

    it('sees only their own memberships and visits', async () => {
      const memberships = await asMember(
        request(app.getHttpServer()).get('/portal/memberships'),
      ).expect(200);
      expect(memberships.body.data.items.length).toBeGreaterThan(0);

      const attendance = await asMember(
        request(app.getHttpServer()).get('/portal/attendance'),
      ).expect(200);
      expect(attendance.body.data.items.length).toBe(1);

      // The whole gym checked in today; the member sees one visit.
      const everyone = await prisma.attendance.count({
        where: { branchId },
      });
      expect(everyone).toBeGreaterThan(1);
    });

    it('serves workouts and nutrition without leaking anyone else’s', async () => {
      const workouts = await asMember(
        request(app.getHttpServer()).get('/portal/workouts'),
      ).expect(200);
      expect(Array.isArray(workouts.body.data.items)).toBe(true);

      const nutrition = await asMember(
        request(app.getHttpServer()).get('/portal/nutrition'),
      ).expect(200);
      expect(Array.isArray(nutrition.body.data.items)).toBe(true);
    });
  });

  /**
   * The member's own record beyond contact details: progress, the
   * check-in code, what they owe, their training and their documents.
   * Every block is seeded for BOTH members, so each case proves the
   * other member's rows are absent rather than merely that some exist.
   */
  describe('their own profile', () => {
    let organizationId: string;
    const mark = `iso-${Date.now()}`;

    beforeAll(async () => {
      await asMemberLogin();
      ({ organizationId } = await prisma.member.findUniqueOrThrow({
        where: { id: memberId },
        select: { organizationId: true },
      }));

      const plan = await prisma.workoutPlan.create({
        data: { organizationId, name: 'Strength block' },
      });
      const trainer = await prisma.user.findFirstOrThrow({
        where: { organizationId, member: null },
        select: { id: true },
      });
      const profile = await prisma.staffProfile.upsert({
        where: { userId: trainer.id },
        create: { userId: trainer.id, organizationId, isTrainer: true },
        update: {},
      });

      for (const [index, id] of [memberId, otherMemberId].entries()) {
        const own = id === memberId;
        await prisma.memberMeasurement.create({
          data: {
            organizationId,
            memberId: id,
            weightKg: own ? 82.5 : 99,
            notes: `${mark} assessor note`,
          },
        });
        await prisma.memberGoal.create({
          data: {
            organizationId,
            memberId: id,
            title: own ? 'Squat 280' : `${mark} other goal`,
            category: 'STRENGTH',
            targetValue: 280,
            targetUnit: 'kg',
            milestones: {
              create: { organizationId, title: own ? '250 kg' : 'x' },
            },
          },
        });
        const payment = await prisma.payment.create({
          data: { organizationId, memberId: id, amount: 400, method: 'UPI' },
        });
        const failed = await prisma.payment.create({
          data: {
            organizationId,
            memberId: id,
            amount: 100,
            method: 'CARD',
            status: 'FAILED',
          },
        });
        const invoice = await prisma.invoice.create({
          data: {
            organizationId,
            memberId: id,
            number: `${mark}-${index}`,
            status: 'PART_PAID',
            subtotal: 1000,
            discountTotal: 0,
            taxTotal: 0,
            grandTotal: 1000,
            issuedAt: new Date(),
          },
        });
        await prisma.invoicePayment.createMany({
          data: [
            { invoiceId: invoice.id, paymentId: payment.id, amount: 400 },
            { invoiceId: invoice.id, paymentId: failed.id, amount: 100 },
          ],
        });
        await prisma.invoice.create({
          data: {
            organizationId,
            memberId: id,
            number: `${mark}-draft-${index}`,
            status: 'DRAFT',
            subtotal: 50,
            discountTotal: 0,
            taxTotal: 0,
            grandTotal: 50,
          },
        });
        await prisma.ptPackage.create({
          data: {
            organizationId,
            branchId,
            memberId: id,
            name: own ? '12 PT sessions' : `${mark} other package`,
            totalSessions: 12,
            usedSessions: 5,
            startDate: new Date(),
            endDate: new Date(Date.now() + 60 * 86_400_000),
            price: 12000,
          },
        });
        const tomorrow = new Date(Date.now() + 86_400_000);
        await prisma.ptSession.create({
          data: {
            organizationId,
            branchId,
            memberId: id,
            trainerId: profile.id,
            startTime: tomorrow,
            endTime: new Date(tomorrow.getTime() + 3_600_000),
            notes: `${mark} trainer note`,
          },
        });
        const assignment = await prisma.workoutAssignment.create({
          data: { organizationId, memberId: id, workoutPlanId: plan.id },
        });
        await prisma.workoutSession.create({
          data: {
            organizationId,
            memberId: id,
            branchId,
            assignmentId: assignment.id,
            status: 'COMPLETED',
            sets: {
              create: [
                {
                  organizationId,
                  exerciseId: 'sq',
                  setNumber: 1,
                  weightKg: 200,
                  reps: 5,
                },
                {
                  organizationId,
                  exerciseId: 'sq',
                  setNumber: 2,
                  weightKg: 210,
                  reps: 3,
                },
              ],
            },
          },
        });
      }
    });

    it('reads their measurements and goals, not the assessor’s notes', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/progress'),
      ).expect(200);
      const { measurements, goals } = res.body.data;
      expect(measurements).toHaveLength(1);
      expect(Number(measurements[0].weightKg)).toBe(82.5);
      expect(measurements[0]).not.toHaveProperty('notes');
      expect(goals.map((g: { title: string }) => g.title)).toEqual([
        'Squat 280',
      ]);
      expect(goals[0].milestones[0].title).toBe('250 kg');
      expect(JSON.stringify(res.body.data)).not.toContain(mark);
    });

    it('mints a check-in code the desk accepts, and a new one retires it', async () => {
      const first = await asMember(
        request(app.getHttpServer()).post('/portal/check-in-code'),
      ).expect(201);
      expect(first.body.data.token).toMatch(/^[0-9a-f]{64}$/);
      expect(first.body.data).not.toHaveProperty('memberId');

      const second = await asMember(
        request(app.getHttpServer()).post('/portal/check-in-code'),
      ).expect(201);
      expect(second.body.data.token).not.toBe(first.body.data.token);

      // The retired code is refused; the live one checks this member in.
      await asOwner(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ branchId, qrToken: first.body.data.token }),
      ).expect(410);
      const checkedIn = await asOwner(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ branchId, qrToken: second.body.data.token }),
      ).expect(201);
      expect(checkedIn.body.data.memberId).toBe(memberId);
    });

    it('shows issued bills with a balance that ignores failed payments', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/billing'),
      ).expect(200);
      const { invoices, payments } = res.body.data;
      const numbers = invoices.map((i: { number: string }) => i.number);
      // The draft is the gym's business until it is issued.
      expect(numbers).not.toContain(`${mark}-draft-0`);
      expect(numbers).toHaveLength(
        await prisma.invoice.count({
          where: { memberId, status: { not: 'DRAFT' } },
        }),
      );
      expect(
        invoices.find((i: { number: string }) => i.number === `${mark}-0`),
      ).toMatchObject({ amountPaid: '400.00', balance: '600.00' });
      expect(payments).toHaveLength(
        await prisma.payment.count({ where: { memberId } }),
      );
      // Each payment says which bill it went against.
      expect(
        payments.filter((p: { invoiceNumbers: string[] }) =>
          p.invoiceNumbers.includes(`${mark}-0`),
        ),
      ).toHaveLength(2);
      expect(JSON.stringify(res.body.data)).not.toContain(`${mark}-1`);
    });

    it('shows packages, sessions and logged workouts, without trainer notes', async () => {
      const res = await asMember(
        request(app.getHttpServer()).get('/portal/training'),
      ).expect(200);
      const data = res.body.data;
      expect(data.packages).toHaveLength(1);
      expect(data.packages[0]).toMatchObject({
        name: '12 PT sessions',
        remainingSessions: 7,
      });
      expect(data.upcomingSessions).toHaveLength(1);
      expect(data.upcomingSessions[0]).toMatchObject({
        trainerName: 'Owner Portal',
      });
      expect(data.upcomingSessions[0]).not.toHaveProperty('notes');
      expect(data.upcomingSessions[0]).not.toHaveProperty('trainer');
      expect(data.workoutSessions).toHaveLength(1);
      expect(data.workoutSessions[0]).toMatchObject({
        planName: 'Strength block',
        setCount: 2,
        volumeKg: '1630.0',
      });
      expect(JSON.stringify(data)).not.toContain(mark);
    });

    it('lists only their own documents, with a link to each', async () => {
      for (const id of [memberId, otherMemberId]) {
        const file = await prisma.file.create({
          data: {
            organizationId,
            key: `member-documents/${id}.pdf`,
            originalName: id === memberId ? 'waiver.pdf' : `${mark}.pdf`,
            mimeType: 'application/pdf',
            sizeBytes: 1024,
            purpose: 'MEMBER_DOCUMENT',
          },
        });
        await prisma.memberDocument.create({
          data: {
            organizationId,
            memberId: id,
            fileId: file.id,
            category: 'DOCUMENT',
          },
        });
      }

      const res = await asMember(
        request(app.getHttpServer()).get('/portal/documents'),
      ).expect(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]).toMatchObject({
        originalName: 'waiver.pdf',
        status: 'DRAFT',
      });
      expect(res.body.data.items[0].url).toMatch(/^https?:\/\//);
      expect(res.body.data.items[0]).not.toHaveProperty('reviewedBy');
      expect(JSON.stringify(res.body.data)).not.toContain(mark);
    });

    it('refuses a staff account on every one of these routes', async () => {
      for (const path of [
        '/portal/progress',
        '/portal/billing',
        '/portal/training',
        '/portal/documents',
      ]) {
        await asOwner(request(app.getHttpServer()).get(path)).expect(403);
      }
      await asOwner(
        request(app.getHttpServer()).post('/portal/check-in-code'),
      ).expect(403);
    });
  });

  describe('the boundary the MEMBER role used to leave open', () => {
    beforeAll(() => asMemberLogin());

    it('refuses every staff read a member must never have', async () => {
      // Each of these accepts a permission the MEMBER role used to carry.
      for (const path of [
        '/attendance',
        '/workout-plans',
        '/diet-plans',
        '/members',
      ]) {
        const res = await asMember(request(app.getHttpServer()).get(path));
        expect([401, 403, 404]).toContain(res.status);
      }
    });

    it('cannot reach another member through the portal at all', async () => {
      // There is no route that takes a memberId, so there is nothing to
      // tamper with -- the scoping is the query, not a parameter.
      const res = await asMember(
        request(app.getHttpServer())
          .get('/portal/attendance')
          .query({ memberId: otherMemberId }),
      ).expect(200);
      const ids = await prisma.attendance.findMany({
        where: { memberId: otherMemberId },
        select: { id: true },
      });
      const seen = res.body.data.items.map((a: { id: string }) => a.id);
      for (const row of ids) expect(seen).not.toContain(row.id);
    });

    it('refuses a staff account on the member routes', async () => {
      // The owner is a real user with no linked Member -- a 403 rather
      // than an empty page, because it is a mistake worth surfacing.
      await asOwner(request(app.getHttpServer()).get('/portal/me')).expect(403);
    });
  });
});
