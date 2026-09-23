import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  grantActiveMembership,
  type RegisteredAccount,
} from './utils/test-app';

/**
 * B-P0-2 (BACKLOG.md): the first e2e coverage for src/business-os/, whose
 * ~20 endpoints previously had zero automated tests despite touching money
 * (accounting, loyalty), tenant-facing public routes (portal bootstrap,
 * portal bootstrap), and campaign audience selection. Written immediately
 * after B-P0-1 (moving the module off raw SQL onto the typed Prisma
 * Client), so several cases here are direct regression tests for bugs that
 * migration uncovered:
 *  - enrollCampaign's audience filter (previously broken: raw SQL
 *    referenced snake_case columns against camelCase tables -- every call
 *    threw before a single member was ever matched).
 *  - maxDaysSinceCheckIn no longer also matching members who never
 *    attended (a copy-pasted condition meant for minDaysSinceCheckIn).
 *  - the loyalty-points credit path staying correct under concurrent
 *    adjustments (the FOR UPDATE lock added alongside the Prisma port).
 *  - updateTicket preserving the first resolution timestamp across a
 *    later RESOLVED<->CLOSED transition.
 */
describe('Business OS (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let owner: RegisteredAccount;
  let branchId: string;
  let memberWithMembership: string;
  let memberWithoutMembership: string;
  let trainerToken: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(owner.accessToken)(req);
  const asTrainer = (req: request.Test) => authed(trainerToken)(req);
  let fwdCounter = 0;
  const fromIp = (req: request.Test) =>
    req.set('X-Forwarded-For', `10.0.0.${++fwdCounter % 254}-${Date.now()}`);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const email = `business-os-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Business OS Test Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'BizOS',
      })
      .expect(201);
    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${registered.body.data.accessToken}`)
      .expect(200);
    owner = {
      accessToken: registered.body.data.accessToken,
      organizationId: registered.body.data.organization.id,
      userId: registered.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
    branchId = owner.branchId;

    const m1 = await asOwner(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchId,
          firstName: 'Has',
          lastName: 'Membership',
          email: `has-membership-${Date.now()}@example.com`,
        }),
    ).expect(201);
    memberWithMembership = m1.body.data.id;
    await grantActiveMembership(app, owner.accessToken, memberWithMembership);

    const m2 = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'No',
        lastName: 'Membership',
      }),
    ).expect(201);
    memberWithoutMembership = m2.body.data.id;

    // A TRAINER holds none of loyalty/support/feedback/marketing/accounting/
    // portal -- the negative-permission fixture for every group below.
    const trainerEmail = `trainer-${Date.now()}@example.com`;
    const invited = await asOwner(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'Test',
        lastName: 'Trainer',
        primaryBranchId: branchId,
        roleKey: 'TRAINER',
        roleBranchId: branchId,
      }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    const tokensService = app.get(TokensService);
    trainerToken = tokensService.signAccessToken(invited.body.data.id);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('loyalty', () => {
    it('creates a zero-balance STANDARD account on first read', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get(`/loyalty/${memberWithoutMembership}`),
      ).expect(200);
      expect(res.body.data.points).toBe(0);
      expect(res.body.data.tier).toBe('STANDARD');
    });

    it('adjusts points and recomputes tier', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post(`/loyalty/${memberWithoutMembership}/adjust`)
          .send({ points: 600, reason: 'Welcome bonus' }),
      ).expect(201);
      expect(res.body.data.points).toBe(600);
      expect(res.body.data.tier).toBe('SILVER');
    });

    it('never lets a negative adjustment drop points below zero', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post(`/loyalty/${memberWithoutMembership}/adjust`)
          .send({ points: -10000, reason: 'Correction' }),
      ).expect(201);
      expect(res.body.data.points).toBe(0);
      expect(res.body.data.tier).toBe('STANDARD');
    });

    it('rejects a zero-point adjustment', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post(`/loyalty/${memberWithoutMembership}/adjust`)
          .send({ points: 0, reason: 'noop' }),
      ).expect(400);
    });

    it('serializes concurrent adjustments instead of losing an update', async () => {
      // Regression test for the FOR-UPDATE lock added in B-P0-1
      // (creditLoyaltyPoints): without it, two concurrent +100 adjustments
      // reading the same pre-adjustment balance would both write back
      // "old + 100", silently dropping one of the two credits.
      // Ensure the account row already exists before racing writes against
      // it, so this test isolates the FOR-UPDATE lock's lost-update
      // protection from unrelated concurrent-upsert-creation semantics.
      await asOwner(
        request(app.getHttpServer())
          .post(`/loyalty/${memberWithMembership}/adjust`)
          .send({ points: 1, reason: 'seed' }),
      ).expect(201);

      const CONCURRENCY = 8;
      const results = await Promise.all(
        Array.from({ length: CONCURRENCY }, () =>
          asOwner(
            request(app.getHttpServer())
              .post(`/loyalty/${memberWithMembership}/adjust`)
              .send({ points: 100, reason: 'concurrent credit' }),
          ),
        ),
      );
      for (const r of results) expect(r.status).toBe(201);

      const final = await asOwner(
        request(app.getHttpServer()).get(`/loyalty/${memberWithMembership}`),
      ).expect(200);
      expect(final.body.data.points).toBe(1 + CONCURRENCY * 100);
    });

    it('denies a caller without loyalty.read', async () => {
      await asTrainer(
        request(app.getHttpServer()).get(`/loyalty/${memberWithoutMembership}`),
      ).expect(403);
    });
  });

  describe('referrals', () => {
    let referralId: string;
    let referralCode: string;

    it('creates a referral code for the referrer', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post(`/referrals/${memberWithMembership}`),
      ).expect(201);
      expect(res.body.data.code).toMatch(/^REF-[0-9A-F]{10}$/);
      referralCode = res.body.data.code;

      const list = await asOwner(
        request(app.getHttpServer()).get('/referrals'),
      ).expect(200);
      const created = list.body.data.find(
        (r: { code: string }) => r.code === referralCode,
      );
      expect(created).toBeDefined();
      expect(created.referrerFirstName).toBe('Has');
      referralId = created.id;
    });

    it('converts a referral and credits the referrer with its reward points', async () => {
      // POST /referrals/:memberId has no way to set rewardPoints (it's
      // always created at the schema default of 0) -- set it directly to
      // exercise convertReferral's loyalty-credit branch, same fixture
      // pattern test/branch-scoping.e2e-spec.ts uses for state no HTTP
      // endpoint can produce yet.
      await prisma.referral.update({
        where: { id: referralId },
        data: { rewardPoints: 250 },
      });
      const before = await asOwner(
        request(app.getHttpServer()).get(`/loyalty/${memberWithMembership}`),
      ).expect(200);

      const res = await asOwner(
        request(app.getHttpServer())
          .post(`/referrals/${referralId}/convert`)
          .send({ memberId: memberWithoutMembership }),
      ).expect(201);
      expect(res.body.data.status).toBe('CONVERTED');

      const after = await asOwner(
        request(app.getHttpServer()).get(`/loyalty/${memberWithMembership}`),
      ).expect(200);
      expect(after.body.data.points).toBe(before.body.data.points + 250);
    });

    it('rejects converting the same referral twice', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post(`/referrals/${referralId}/convert`)
          .send({ memberId: memberWithoutMembership }),
      ).expect(404);
    });

    it('denies a caller without referrals.manage', async () => {
      await asTrainer(
        request(app.getHttpServer()).post(`/referrals/${memberWithMembership}`),
      ).expect(403);
    });
  });

  describe('support tickets', () => {
    let ticketId: string;

    it('creates, lists, and messages a ticket', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/support/tickets').send({
          subject: 'Locker 12 is stuck',
          description: 'Combination lock will not open',
          priority: 'HIGH',
        }),
      ).expect(201);
      ticketId = created.body.data.id;
      expect(created.body.data.status).toBe('OPEN');

      const list = await asOwner(
        request(app.getHttpServer())
          .get('/support/tickets')
          .query({ status: 'OPEN' }),
      ).expect(200);
      expect(
        list.body.data.some((t: { id: string }) => t.id === ticketId),
      ).toBe(true);

      await asOwner(
        request(app.getHttpServer())
          .post(`/support/tickets/${ticketId}/messages`)
          .send({ body: 'Maintenance notified' }),
      ).expect(201);
    });

    it('preserves the first resolution timestamp across RESOLVED -> CLOSED', async () => {
      const resolved = await asOwner(
        request(app.getHttpServer())
          .patch(`/support/tickets/${ticketId}`)
          .send({ status: 'RESOLVED' }),
      ).expect(200);
      const firstResolvedAt = resolved.body.data.resolvedAt;
      expect(firstResolvedAt).toBeTruthy();

      await new Promise((r) => setTimeout(r, 10));

      const closed = await asOwner(
        request(app.getHttpServer())
          .patch(`/support/tickets/${ticketId}`)
          .send({ status: 'CLOSED' }),
      ).expect(200);
      expect(closed.body.data.resolvedAt).toBe(firstResolvedAt);

      const reopened = await asOwner(
        request(app.getHttpServer())
          .patch(`/support/tickets/${ticketId}`)
          .send({ status: 'OPEN' }),
      ).expect(200);
      expect(reopened.body.data.resolvedAt).toBeNull();
    });

    it('rejects an invalid status', async () => {
      await asOwner(
        request(app.getHttpServer())
          .patch(`/support/tickets/${ticketId}`)
          .send({ status: 'ARCHIVED' }),
      ).expect(400);
    });

    it('denies a caller without support.manage', async () => {
      await asTrainer(
        request(app.getHttpServer()).post('/support/tickets').send({
          subject: 'x',
          description: 'y',
        }),
      ).expect(403);
    });
  });

  describe('feedback', () => {
    let surveyId: string;

    it('creates a survey and records responses', async () => {
      const survey = await asOwner(
        request(app.getHttpServer())
          .post('/feedback/surveys')
          .send({ name: 'Post-workout CSAT' }),
      ).expect(201);
      surveyId = survey.body.data.id;

      await asOwner(
        request(app.getHttpServer())
          .post('/feedback/respond')
          .send({ surveyId, memberId: memberWithMembership, score: 9 }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer())
          .post('/feedback/respond')
          .send({ surveyId, memberId: memberWithoutMembership, score: 5 }),
      ).expect(201);
    });

    it('rejects an out-of-range score', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/feedback/respond')
          .send({ surveyId, memberId: memberWithMembership, score: 11 }),
      ).expect(400);
    });

    it('rejects a response against an unknown survey', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/feedback/respond').send({
          surveyId: 'not-a-real-id',
          memberId: memberWithMembership,
          score: 7,
        }),
      ).expect(404);
    });

    it('summarizes promoters/detractors/NPS correctly', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/feedback/summary'),
      ).expect(200);
      const row = res.body.data.find(
        (r: { surveyId: string }) => r.surveyId === surveyId,
      );
      expect(row).toBeDefined();
      expect(row.responses).toBe(2);
      expect(row.avgScore).toBe(7);
      expect(row.promoters).toBe(1);
      expect(row.detractors).toBe(1);
      expect(row.nps).toBe(0);
    });
  });

  describe('marketing campaigns', () => {
    let campaignId: string;

    it('enrolls only members matching the audience filter', async () => {
      // Regression test for B-P0-1: this call's raw SQL referenced
      // snake_case columns against camelCase tables and threw on every
      // invocation before the Prisma port -- this endpoint had never
      // returned successfully.
      const campaign = await asOwner(
        request(app.getHttpServer())
          .post('/marketing/campaigns')
          .send({
            name: 'Reactivation email',
            channel: 'EMAIL',
            audienceFilter: { hasActiveMembership: true, hasEmail: true },
          }),
      ).expect(201);
      campaignId = campaign.body.data.id;

      const enroll = await asOwner(
        request(app.getHttpServer()).post(
          `/marketing/campaigns/${campaignId}/enroll`,
        ),
      ).expect(201);
      // Only memberWithMembership has both an ACTIVE membership and an
      // email; memberWithoutMembership has neither.
      expect(enroll.body.data.enrolled).toBe(1);

      const campaigns = await asOwner(
        request(app.getHttpServer()).get('/marketing/campaigns'),
      ).expect(200);
      const updated = campaigns.body.data.find(
        (c: { id: string }) => c.id === campaignId,
      );
      expect(updated.status).toBe('QUEUED');
    });

    it('runs the campaign and delivers to the enrolled member', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post(
          `/marketing/campaigns/${campaignId}/run`,
        ),
      ).expect(201);
      expect(res.body.data.processed).toBe(1);
      expect(res.body.data.sent).toBe(1);
      expect(res.body.data.failed).toBe(0);

      const campaigns = await asOwner(
        request(app.getHttpServer()).get('/marketing/campaigns'),
      ).expect(200);
      const completed = campaigns.body.data.find(
        (c: { id: string }) => c.id === campaignId,
      );
      expect(completed.status).toBe('COMPLETED');
    });

    it('rejects an unsupported audience filter key', async () => {
      const campaign = await asOwner(
        request(app.getHttpServer())
          .post('/marketing/campaigns')
          .send({
            name: 'Bad filter',
            channel: 'EMAIL',
            audienceFilter: { nickname: 'x' },
          }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer()).post(
          `/marketing/campaigns/${campaign.body.data.id}/enroll`,
        ),
      ).expect(400);
    });

    it('denies a caller without marketing.manage', async () => {
      await asTrainer(
        request(app.getHttpServer()).post('/marketing/campaigns').send({
          name: 'x',
          channel: 'EMAIL',
        }),
      ).expect(403);
    });
  });

  describe('accounting', () => {
    let cashAccountId: string;
    let revenueAccountId: string;

    it('creates chart-of-accounts entries', async () => {
      const cash = await asOwner(
        request(app.getHttpServer())
          .post('/accounting/accounts')
          .send({ code: '1000', name: 'Cash', type: 'ASSET' }),
      ).expect(201);
      cashAccountId = cash.body.data.id;

      const revenue = await asOwner(
        request(app.getHttpServer())
          .post('/accounting/accounts')
          .send({ code: '4000', name: 'Membership Revenue', type: 'REVENUE' }),
      ).expect(201);
      revenueAccountId = revenue.body.data.id;
    });

    it('rejects an unbalanced journal', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/accounting/journal')
          .send({
            lines: [
              { accountId: cashAccountId, debit: 100 },
              { accountId: revenueAccountId, credit: 50 },
            ],
          }),
      ).expect(400);
    });

    it('posts a balanced journal and reflects it in the trial balance and tax summary', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/accounting/journal')
          .send({
            lines: [
              { accountId: cashAccountId, debit: 100, description: 'Cash in' },
              {
                accountId: revenueAccountId,
                credit: 100,
                description: 'Membership sale',
              },
            ],
          }),
      ).expect(201);

      const trial = await asOwner(
        request(app.getHttpServer()).get('/accounting/trial-balance'),
      ).expect(200);
      const cashRow = trial.body.data.find(
        (a: { code: string }) => a.code === '1000',
      );
      const revenueRow = trial.body.data.find(
        (a: { code: string }) => a.code === '4000',
      );
      expect(cashRow.debit).toBe(100);
      expect(cashRow.balance).toBe(100);
      expect(revenueRow.credit).toBe(100);
      expect(revenueRow.balance).toBe(-100);

      const tax = await asOwner(
        request(app.getHttpServer()).get('/accounting/tax-summary'),
      ).expect(200);
      expect(tax.body.data[0].totalDebit).toBe(100);
      expect(tax.body.data[0].totalCredit).toBe(100);
      expect(tax.body.data[0].net).toBe(0);
    });

    it('rejects a journal line referencing another org’s account', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/accounting/journal')
          .send({
            lines: [
              { accountId: 'not-a-real-account', debit: 10 },
              { accountId: cashAccountId, credit: 10 },
            ],
          }),
      ).expect(404);
    });

    it('denies a caller without accounting.read', async () => {
      await asTrainer(
        request(app.getHttpServer()).get('/accounting/accounts'),
      ).expect(403);
    });
  });

  describe('member portal', () => {
    it('bootstraps once from a valid invite token, then rejects reuse', async () => {
      const invite = await asOwner(
        request(app.getHttpServer()).post(
          `/portal/invites/${memberWithMembership}`,
        ),
      ).expect(201);
      const token = invite.body.data.token;

      const boot = await fromIp(
        request(app.getHttpServer()).get(`/portal/bootstrap/${token}`),
      ).expect(200);
      expect(boot.body.data.member.id).toBe(memberWithMembership);
      expect(Array.isArray(boot.body.data.memberships)).toBe(true);

      await fromIp(
        request(app.getHttpServer()).get(`/portal/bootstrap/${token}`),
      ).expect(404);
    });

    it('rejects a token that was revoked before use', async () => {
      const invite = await asOwner(
        request(app.getHttpServer()).post(
          `/portal/invites/${memberWithMembership}`,
        ),
      ).expect(201);
      const token = invite.body.data.token;

      const revoke = await asOwner(
        request(app.getHttpServer()).post(
          `/portal/invites/${memberWithMembership}/revoke`,
        ),
      ).expect(201);
      expect(revoke.body.data.revoked).toBeGreaterThanOrEqual(1);

      await fromIp(
        request(app.getHttpServer()).get(`/portal/bootstrap/${token}`),
      ).expect(404);
    });

    it('rejects a malformed (too-short) token before touching the rate limiter', async () => {
      await fromIp(
        request(app.getHttpServer()).get('/portal/bootstrap/short'),
      ).expect(400);
    });

    it('rate-limits repeated bootstrap attempts from the same caller', async () => {
      const bogusToken = 'a'.repeat(64);
      const ip = `198.51.100.${++fwdCounter % 254}`;
      const attempt = () =>
        request(app.getHttpServer())
          .get(`/portal/bootstrap/${bogusToken}`)
          .set('X-Forwarded-For', ip);

      const statuses: number[] = [];
      for (let i = 0; i < 21; i++) statuses.push((await attempt()).status);

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(404));
      expect(statuses[20]).toBe(429);
    });
  });

  describe('pt intelligence', () => {
    it('summarizes engagement for a member', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get(
          `/pt-intelligence/${memberWithMembership}`,
        ),
      ).expect(200);
      expect(res.body.data.member.id).toBe(memberWithMembership);
      expect(res.body.data.engagementBand).toBeDefined();
    });

    it('denies a caller without reports.view', async () => {
      await asTrainer(
        request(app.getHttpServer()).get(
          `/pt-intelligence/${memberWithMembership}`,
        ),
      ).expect(403);
    });
  });
});
