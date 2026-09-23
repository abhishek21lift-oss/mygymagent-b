import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { TokensService } from '../src/auth/tokens.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-10 (BACKLOG.md): enforcing a second factor on privileged roles.
 *
 * B-P0-4 shipped the capability; this is the policy that makes it bite.
 * The risk the backlog names is not that enforcement fails to engage --
 * it is that it engages too hard and locks an organization's owner out of
 * their own account, because enrolling needs a session and a refused login
 * grants none. So the properties pinned down here are, in order:
 *
 *  - OPTIONAL organizations behave exactly as they did before;
 *  - the report tells an admin who is unprotected BEFORE they switch it on;
 *  - switching it on without naming a date buys a grace window rather than
 *    restricting everyone the same second;
 *  - during grace, a privileged unenrolled user keeps a FULL session and is
 *    merely warned;
 *  - after grace, that user still gets a session -- confined to the
 *    enrolment screens, never refused, or the lockout is permanent;
 *  - the confinement is real: ordinary endpoints 403;
 *  - finishing enrolment lifts it on the very next request, with no new
 *    token;
 *  - roles the policy does not cover are untouched throughout.
 */
describe('MFA policy for privileged roles (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;

  let organizationId: string;
  let branchId: string;
  let ownerId: string;
  let ownerEmail: string;
  let ownerToken: string;
  let trainerId: string;
  let trainerToken: string;

  const password = 'CorrectHorseBattery9';
  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);

  const ownerLogin = () =>
    request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ownerEmail, password });

  const setPolicy = (body: Record<string, unknown>) =>
    asOwner(request(app.getHttpServer()).patch('/auth/mfa/policy').send(body));

  /** Moves the organization's grace deadline into the past without waiting
   * for real time to pass. This is the state a tenant reaches naturally
   * the day after their deadline. */
  const expireGrace = () =>
    prisma.organization.update({
      where: { id: organizationId },
      data: { mfaGraceUntil: new Date(Date.now() - 1000) },
    });

  /** Completes a real enrolment for `userId` and returns nothing -- the
   * point is the resulting DB state, not the codes. */
  const enrol = async (token: string) => {
    const setup = await authed(token)(
      request(app.getHttpServer()).post('/auth/mfa/setup'),
    ).expect(201);
    await authed(token)(
      request(app.getHttpServer())
        .post('/auth/mfa/enable')
        .send({ code: authenticator.generate(setup.body.data.secret) }),
    ).expect(201);
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    ownerEmail = `mfa-policy-owner-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'MFA Policy Gym',
        email: ownerEmail,
        password,
        firstName: 'Olive',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    ownerId = registered.body.data.user.id;
    organizationId = registered.body.data.organization.id;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    // A role the policy deliberately does NOT cover, so every assertion
    // below has a control case.
    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `mfa-policy-trainer-${Date.now()}@example.com`,
          firstName: 'Tam',
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
    trainerToken = tokens.signAccessToken(trainerId);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('before any policy is set', () => {
    it('defaults to OPTIONAL, so nothing changes for anyone', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/auth/mfa/policy'),
      ).expect(200);
      expect(res.body.data.policy).toBe('OPTIONAL');
      expect(res.body.data.graceUntil).toBeNull();
      expect(res.body.data.enforcementActive).toBe(false);
      expect(res.body.data.privilegedRoles).toEqual([
        'ORG_OWNER',
        'ORG_ADMIN',
        'ACCOUNTANT',
      ]);
    });

    it('lets an unenrolled owner log in and use the app normally', async () => {
      const res = await ownerLogin().expect(201);
      expect(res.body.data.accessToken).toBeTruthy();
      expect(res.body.data.mfaEnrolment.state).toBe('NOT_REQUIRED');

      await authed(res.body.data.accessToken)(
        request(app.getHttpServer()).get('/members'),
      ).expect(200);
    });
  });

  describe('the enrolment report', () => {
    it('names exactly who the policy would cover, and their state', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/auth/mfa/policy/report'),
      ).expect(200);

      expect(res.body.data.summary).toEqual({
        total: 1,
        enrolled: 0,
        pending: 1,
      });
      expect(res.body.data.users).toHaveLength(1);
      expect(res.body.data.users[0]).toMatchObject({
        id: ownerId,
        email: ownerEmail,
        roles: ['ORG_OWNER'],
        mfaEnabled: false,
        mfaEnabledAt: null,
      });
      // The trainer is not a covered role, so they are not in the report.
      expect(
        res.body.data.users.some((u: { id: string }) => u.id === trainerId),
      ).toBe(false);
    });

    it('is not readable by a role that cannot set the policy', async () => {
      // The report is a list of which privileged accounts are unprotected;
      // that is reconnaissance, not general staff information.
      await authed(trainerToken)(
        request(app.getHttpServer()).get('/auth/mfa/policy/report'),
      ).expect(403);
      await authed(trainerToken)(
        request(app.getHttpServer()).patch('/auth/mfa/policy').send({
          policy: 'OPTIONAL',
        }),
      ).expect(403);
    });
  });

  describe('switching enforcement on', () => {
    it('grants a default grace window rather than restricting immediately', async () => {
      const before = Date.now();
      const res = await setPolicy({
        policy: 'REQUIRED_FOR_PRIVILEGED',
      }).expect(200);

      expect(res.body.data.policy).toBe('REQUIRED_FOR_PRIVILEGED');
      expect(res.body.data.enforcementActive).toBe(false);
      const deadline = new Date(res.body.data.graceUntil).getTime();
      // 14 days, give or take the time this test took to run.
      expect(deadline).toBeGreaterThan(before + 13 * 86_400_000);
      expect(deadline).toBeLessThan(before + 15 * 86_400_000);
    });

    it('rejects a grace deadline that is already in the past', async () => {
      await setPolicy({
        policy: 'REQUIRED_FOR_PRIVILEGED',
        graceUntil: new Date(Date.now() - 60_000).toISOString(),
      }).expect(400);
    });

    it('does not hand out a fresh window when an existing policy is re-saved', async () => {
      const first = await asOwner(
        request(app.getHttpServer()).get('/auth/mfa/policy'),
      ).expect(200);
      const res = await setPolicy({
        policy: 'REQUIRED_FOR_PRIVILEGED',
      }).expect(200);
      // Re-saving must not quietly extend the deadline -- that would let a
      // policy be kept perpetually toothless by touching the settings page.
      expect(res.body.data.graceUntil).toBe(first.body.data.graceUntil);
    });
  });

  describe('during the grace period', () => {
    it('warns the privileged user at login but leaves the session full', async () => {
      const res = await ownerLogin().expect(201);
      expect(res.body.data.mfaEnrolment.state).toBe('GRACE');
      expect(res.body.data.mfaEnrolment.deadline).toBeTruthy();

      // The warning is a warning: the session still works.
      await authed(res.body.data.accessToken)(
        request(app.getHttpServer()).get('/members'),
      ).expect(200);
    });

    it('repeats the deadline on /auth/me, so a reload does not lose it', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/auth/me'),
      ).expect(200);
      expect(res.body.data.mfaEnrolment.state).toBe('GRACE');
      expect(res.body.data.mfaEnrolment.deadline).toBeTruthy();
    });

    it('says nothing to a role the policy does not cover', async () => {
      const res = await authed(trainerToken)(
        request(app.getHttpServer()).get('/auth/me'),
      ).expect(200);
      expect(res.body.data.mfaEnrolment.state).toBe('NOT_REQUIRED');
    });
  });

  describe('once the grace period has passed', () => {
    beforeAll(async () => {
      await expireGrace();
    });

    it('still issues a session instead of refusing the login', async () => {
      // This is the whole safety property. A refusal here would be
      // permanent: enrolling needs a session, and this login is the only
      // way to get one.
      const res = await ownerLogin().expect(201);
      expect(res.body.data.accessToken).toBeTruthy();
      expect(res.body.data.mfaEnrolment.state).toBe('ENFORCED');
      ownerToken = res.body.data.accessToken;
    });

    it('confines that session to the enrolment screens', async () => {
      await asOwner(request(app.getHttpServer()).get('/members')).expect(403);
      await asOwner(request(app.getHttpServer()).get('/branches')).expect(403);
      // Reading the policy is an ordinary admin action, not enrolment.
      await asOwner(
        request(app.getHttpServer()).get('/auth/mfa/policy'),
      ).expect(403);
    });

    it('still lets that session see itself and reach enrolment', async () => {
      await asOwner(request(app.getHttpServer()).get('/auth/me')).expect(200);
      await asOwner(request(app.getHttpServer()).get('/auth/mfa')).expect(200);
    });

    it('leaves an uncovered role completely unaffected', async () => {
      await authed(trainerToken)(
        request(app.getHttpServer()).get('/members'),
      ).expect(200);
    });

    it('lifts the restriction on the next request once enrolment completes', async () => {
      await enrol(ownerToken);

      // Same token as before -- the restriction is recomputed per request,
      // not carried in the JWT, so nothing has to be reissued.
      await asOwner(request(app.getHttpServer()).get('/members')).expect(200);

      const me = await asOwner(
        request(app.getHttpServer()).get('/auth/me'),
      ).expect(200);
      expect(me.body.data.mfaEnrolment.state).toBe('NOT_REQUIRED');
    });

    it('reports the owner as protected afterwards', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/auth/mfa/policy/report'),
      ).expect(200);
      expect(res.body.data.summary).toEqual({
        total: 1,
        enrolled: 1,
        pending: 0,
      });
      expect(res.body.data.enforcementActive).toBe(true);
      expect(res.body.data.users[0].mfaEnabledAt).toBeTruthy();
    });
  });

  describe('turning the policy back off', () => {
    it('clears the stale grace date so a later re-enable is not instant', async () => {
      const res = await setPolicy({ policy: 'OPTIONAL' }).expect(200);
      expect(res.body.data.policy).toBe('OPTIONAL');
      // A deadline left behind here would already be in the past, so the
      // next enable would enforce with no warning at all.
      expect(res.body.data.graceUntil).toBeNull();
      expect(res.body.data.enforcementActive).toBe(false);
    });
  });
});
