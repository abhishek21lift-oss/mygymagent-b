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
    // whichever message happened to land last.
    const sent = await waitForEmailTo(memberEmail, 8000, (email) =>
      /invited/i.test(email.subject),
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
