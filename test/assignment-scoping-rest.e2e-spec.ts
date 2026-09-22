import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * B-P0-3 (BACKLOG.md): closes out audit finding F-05.
 *
 * `test/member-assignment-scoping.e2e-spec.ts` already proves the Members
 * module scopes a TRAINER to their own clients. F-05 was about the *rest*
 * of the surface -- memberships, attendance and workout assignments --
 * which `AI_TASK_STATE.md` claimed was remediated but left its "full
 * verification" boxes unchecked. This suite is that verification, route by
 * route.
 *
 * Writing it found five routes gated on a `*_assigned` permission that
 * never threaded the scope into their query, so a trainer got org-wide
 * results:
 *   - GET /memberships/analytics/summary
 *   - GET /memberships/renewal-reminders   (member PII, unassigned members)
 *   - GET /memberships/history/:id         (any membership's audit trail)
 *   - GET /attendance/live                 (whole-gym live view)
 *   - GET /attendance/qr-token/:memberId   (minted a working entry
 *                                           credential for ANY member)
 * All five are fixed alongside this suite; the cases below are what proves
 * it, and the owner assertions are the control showing the fix didn't just
 * break the broad-permission path instead.
 */
describe('Assignment scoping outside Members (e2e, F-05)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let trainerToken: string;
  let trainerId: string;
  let assignedMemberId: string;
  let unassignedMemberId: string;
  let assignedMembershipId: string;
  let unassignedMembershipId: string;
  let unassignedAttendanceId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asTrainer = (req: request.Test) => authed(trainerToken)(req);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'F05 Scoping Test Gym',
        email: `f05-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'F05',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `f05-trainer-${Date.now()}@example.com`,
          firstName: 'Scoped',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);
    trainerId = invited.body.data.id;
    await prisma.user.update({
      where: { id: trainerId },
      data: { status: 'ACTIVE' },
    });
    trainerToken = app.get(TokensService).signAccessToken(trainerId);

    const assigned = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Mine',
        lastName: 'Client',
        assignedTrainerId: trainerId,
      }),
    ).expect(201);
    assignedMemberId = assigned.body.data.id;

    const unassigned = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Someone',
        lastName: 'Elses',
      }),
    ).expect(201);
    unassignedMemberId = unassigned.body.data.id;

    assignedMembershipId = (
      await grantActiveMembership(app, ownerToken, assignedMemberId)
    ).membershipId;
    unassignedMembershipId = (
      await grantActiveMembership(app, ownerToken, unassignedMemberId)
    ).membershipId;

    // Both members check in (as the owner, who is unscoped), so every read
    // route below has data for an assigned *and* an unassigned member.
    await asOwner(
      request(app.getHttpServer())
        .post('/attendance/check-in')
        .send({ branchId, memberId: assignedMemberId, method: 'MANUAL' }),
    ).expect(201);
    const unassignedCheckIn = await asOwner(
      request(app.getHttpServer())
        .post('/attendance/check-in')
        .send({ branchId, memberId: unassignedMemberId, method: 'MANUAL' }),
    ).expect(201);
    // An allowed check-in returns `{ allowed: true, ...attendanceRecord }`.
    unassignedAttendanceId = unassignedCheckIn.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('memberships', () => {
    it('lists only the trainer’s own clients, while the owner sees both', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer()).get('/memberships'),
      ).expect(200);
      const trainerMemberIds = trainerView.body.data.items.map(
        (m: { memberId: string }) => m.memberId,
      );
      expect(trainerMemberIds).toContain(assignedMemberId);
      expect(trainerMemberIds).not.toContain(unassignedMemberId);

      const ownerView = await asOwner(
        request(app.getHttpServer()).get('/memberships'),
      ).expect(200);
      const ownerMemberIds = ownerView.body.data.items.map(
        (m: { memberId: string }) => m.memberId,
      );
      expect(ownerMemberIds).toEqual(
        expect.arrayContaining([assignedMemberId, unassignedMemberId]),
      );
    });

    it('serves one membership to its trainer and 404s another trainer’s', async () => {
      await asTrainer(
        request(app.getHttpServer()).get(
          `/memberships/${assignedMembershipId}`,
        ),
      ).expect(200);

      await asTrainer(
        request(app.getHttpServer()).get(
          `/memberships/${unassignedMembershipId}`,
        ),
      ).expect(404);
    });

    it('counts only assigned members in the analytics summary', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer()).get('/memberships/analytics/summary'),
      ).expect(200);
      expect(trainerView.body.data.total).toBe(1);

      const ownerView = await asOwner(
        request(app.getHttpServer()).get('/memberships/analytics/summary'),
      ).expect(200);
      expect(ownerView.body.data.total).toBe(2);
    });

    it('leaks no unassigned member PII through renewal reminders', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer())
          .get('/memberships/renewal-reminders')
          .query({ days: 90 }),
      ).expect(200);
      const trainerMemberIds = trainerView.body.data.map(
        (m: { memberId: string }) => m.memberId,
      );
      expect(trainerMemberIds).toContain(assignedMemberId);
      expect(trainerMemberIds).not.toContain(unassignedMemberId);

      const ownerView = await asOwner(
        request(app.getHttpServer())
          .get('/memberships/renewal-reminders')
          .query({ days: 90 }),
      ).expect(200);
      expect(
        ownerView.body.data.map((m: { memberId: string }) => m.memberId),
      ).toEqual(expect.arrayContaining([assignedMemberId, unassignedMemberId]));
    });

    it('refuses the audit trail of an unassigned member’s membership', async () => {
      await asTrainer(
        request(app.getHttpServer()).get(
          `/memberships/history/${assignedMembershipId}`,
        ),
      ).expect(200);

      await asTrainer(
        request(app.getHttpServer()).get(
          `/memberships/history/${unassignedMembershipId}`,
        ),
      ).expect(404);

      await asOwner(
        request(app.getHttpServer()).get(
          `/memberships/history/${unassignedMembershipId}`,
        ),
      ).expect(200);
    });
  });

  describe('attendance', () => {
    it('lists only assigned members’ attendance', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer()).get('/attendance'),
      ).expect(200);
      const memberIds = trainerView.body.data.items.map(
        (a: { memberId: string }) => a.memberId,
      );
      expect(memberIds).toContain(assignedMemberId);
      expect(memberIds).not.toContain(unassignedMemberId);
    });

    it('shows only assigned members in the live turnstile view', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer()).get('/attendance/live'),
      ).expect(200);
      const insideIds = trainerView.body.data.inside.map(
        (a: { memberId: string }) => a.memberId,
      );
      expect(insideIds).toContain(assignedMemberId);
      expect(insideIds).not.toContain(unassignedMemberId);

      const ownerView = await asOwner(
        request(app.getHttpServer()).get('/attendance/live'),
      ).expect(200);
      expect(
        ownerView.body.data.inside.map((a: { memberId: string }) => a.memberId),
      ).toEqual(expect.arrayContaining([assignedMemberId, unassignedMemberId]));
    });

    it('will not mint an entry credential for an unassigned member', async () => {
      // The sharpest case in this suite: this route returns a working QR
      // entry token, so an unscoped version let any trainer produce gym
      // access for a member who isn't theirs.
      const ownClient = await asTrainer(
        request(app.getHttpServer()).get(
          `/attendance/qr-token/${assignedMemberId}`,
        ),
      ).expect(200);
      expect(ownClient.body.data.token).toBeTruthy();

      await asTrainer(
        request(app.getHttpServer()).get(
          `/attendance/qr-token/${unassignedMemberId}`,
        ),
      ).expect(404);

      await asOwner(
        request(app.getHttpServer()).get(
          `/attendance/qr-token/${unassignedMemberId}`,
        ),
      ).expect(200);
    });

    it('refuses to check in or out an unassigned member', async () => {
      await asTrainer(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ branchId, memberId: unassignedMemberId, method: 'MANUAL' }),
      ).expect(404);

      await asTrainer(
        request(app.getHttpServer()).post(
          `/attendance/${unassignedAttendanceId}/check-out`,
        ),
      ).expect(404);
    });
  });

  describe('workout assignments', () => {
    let assignedPlanId: string;

    beforeAll(async () => {
      const exercise = await asOwner(
        request(app.getHttpServer())
          .post('/exercises')
          .send({
            name: `Back Squat ${Date.now()}`,
            muscleGroup: 'LEGS',
          }),
      ).expect(201);

      const plan = await asOwner(
        request(app.getHttpServer())
          .post('/workout-plans')
          .send({
            name: 'Strength Block A',
            exercises: [
              {
                exerciseId: exercise.body.data.id,
                order: 1,
                sets: 5,
                reps: '5',
              },
            ],
          }),
      ).expect(201);
      assignedPlanId = plan.body.data.id;

      for (const memberId of [assignedMemberId, unassignedMemberId]) {
        await asOwner(
          request(app.getHttpServer())
            .post(`/workout-plans/${assignedPlanId}/assign`)
            .send({ memberId }),
        ).expect(201);
      }
    });

    it('lists only assigned members’ workout assignments', async () => {
      const trainerView = await asTrainer(
        request(app.getHttpServer()).get('/workout-assignments'),
      ).expect(200);
      const memberIds = trainerView.body.data.items.map(
        (a: { memberId: string }) => a.memberId,
      );
      expect(memberIds).toContain(assignedMemberId);
      expect(memberIds).not.toContain(unassignedMemberId);

      const ownerView = await asOwner(
        request(app.getHttpServer()).get('/workout-assignments'),
      ).expect(200);
      expect(
        ownerView.body.data.items.map((a: { memberId: string }) => a.memberId),
      ).toEqual(expect.arrayContaining([assignedMemberId, unassignedMemberId]));
    });

    it('returns nothing when explicitly filtering to an unassigned member', async () => {
      // A client-supplied memberId must not widen the scope -- the filter
      // narrows within what the caller may see, it does not bypass it.
      const res = await asTrainer(
        request(app.getHttpServer())
          .get('/workout-assignments')
          .query({ memberId: unassignedMemberId }),
      ).expect(200);
      expect(res.body.data.items).toHaveLength(0);
    });
  });
});
