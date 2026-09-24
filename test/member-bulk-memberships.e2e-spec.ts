import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * `POST /members/bulk/memberships` against real Postgres.
 *
 * This route exists because the Customer Enquiry import deliberately
 * fabricates no `Membership` -- the export carries no plan, price or end
 * date -- which leaves hundreds of members marked ACTIVE with nothing
 * behind them to expire, renew or bill. It is therefore a route whose
 * whole job is to create billable rows in bulk from data that never had
 * them, so the two things worth proving are that a dry run writes
 * nothing, and that it never gives anyone a second overlapping
 * membership.
 */
describe('Members / bulk membership assignment (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let planId: string;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);
    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  async function makeMember(first: string): Promise<string> {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: first,
        lastName: 'Bulk',
      }),
    ).expect(201);
    return res.body.data.id as string;
  }

  async function membershipCount(memberId: string): Promise<number> {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/memberships?memberId=${memberId}`),
    ).expect(200);
    return res.body.data.items.length as number;
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    org = await registerOrg('Bulk Membership Gym');
    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Monthly', durationDays: 30, price: 1500 }),
    ).expect(201);
    planId = plan.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('a dry run reports what it would create and writes nothing', async () => {
    const a = await makeMember('Dry');
    const b = await makeMember('Run');

    const res = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: [a, b],
          membershipPlanId: planId,
          dryRun: true,
        }),
    ).expect(201);

    const report = res.body.data;
    expect(report.dryRun).toBe(true);
    expect(report.requested).toBe(2);
    expect(report.toCreate).toBe(2);
    expect(report.created).toBe(0);
    expect(report.plan.name).toBe('Monthly');
    expect(report.plan.durationDays).toBe(30);
    // Two at 1500 -- the figure the caller is agreeing to before applying.
    expect(report.totalValue).toBe('3000.00');

    // The point of the dry run: nothing exists afterwards.
    expect(await membershipCount(a)).toBe(0);
    expect(await membershipCount(b)).toBe(0);
  });

  it('applies for real when dryRun is absent, and dates the end from the plan', async () => {
    const a = await makeMember('Real');
    const start = '2026-03-01T00:00:00.000Z';

    const res = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: [a],
          membershipPlanId: planId,
          startDate: start,
        }),
    ).expect(201);

    expect(res.body.data.dryRun).toBe(false);
    expect(res.body.data.created).toBe(1);
    expect(res.body.data.startDate).toBe(start);
    // 30 days after 1 March.
    expect(res.body.data.endDate).toBe('2026-03-31T00:00:00.000Z');
    expect(await membershipCount(a)).toBe(1);
  });

  it('never gives a member a second overlapping membership', async () => {
    const a = await makeMember('Once');

    const first = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({ memberIds: [a], membershipPlanId: planId }),
    ).expect(201);
    expect(first.body.data.created).toBe(1);

    const second = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({ memberIds: [a], membershipPlanId: planId }),
    ).expect(201);

    expect(second.body.data.created).toBe(0);
    expect(second.body.data.toCreate).toBe(0);
    expect(second.body.data.skipped.alreadyHasActiveMembership).toBe(1);
    // Named, not just counted.
    expect(second.body.data.skippedMembers).toEqual([
      expect.objectContaining({
        memberId: a,
        reason: 'alreadyHasActiveMembership',
      }),
    ]);
    expect(await membershipCount(a)).toBe(1);
  });

  it('reports members outside the caller organization instead of creating for them', async () => {
    const other = await registerOrg('Someone Elses Gym');
    const foreign = await authed(other.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: other.branchId,
        firstName: 'Not',
        lastName: 'Yours',
      }),
    ).expect(201);
    const mine = await makeMember('Mine');

    const res = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: [mine, foreign.body.data.id],
          membershipPlanId: planId,
          dryRun: true,
        }),
    ).expect(201);

    expect(res.body.data.requested).toBe(2);
    expect(res.body.data.toCreate).toBe(1);
    expect(res.body.data.skipped.outsideYourScope).toBe(1);
  });

  it('rejects an empty selection, an unknown plan, and more than 500 at once', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({ memberIds: [], membershipPlanId: planId }),
    ).expect(400);

    const a = await makeMember('Bad');
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: [a],
          membershipPlanId: '00000000-0000-0000-0000-000000000000',
        }),
    ).expect(404);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: Array.from({ length: 501 }, () => a),
          membershipPlanId: planId,
        }),
    ).expect(400);
  });

  it('stamps the organization currency on the plan and every membership it sells', async () => {
    // 619 Fitness Studio is an INR organization whose three plans were
    // all stored USD, because the form never sends a currency and the
    // column defaults to it -- so a 2000 rupee plan read as $2000, and
    // every membership sold from it inherited that.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/organizations/current')
        .send({ currency: 'INR' }),
    ).expect(200);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Rupee Monthly', durationDays: 30, price: 2000 }),
    ).expect(201);
    expect(plan.body.data.currency).toBe('INR');

    const a = await makeMember('Rupee');
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({ memberIds: [a], membershipPlanId: plan.body.data.id }),
    ).expect(201);

    const sold = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/memberships?memberId=${a}`),
    ).expect(200);
    expect(sold.body.data.items[0].currency).toBe('INR');
  });

  it('refuses a field the DTO does not declare, so a typo cannot be silently ignored', async () => {
    const a = await makeMember('Strict');
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/memberships')
        .send({
          memberIds: [a],
          membershipPlanId: planId,
          // The single-membership route takes this; the bulk one must not,
          // or 291 people get a payment nobody recorded receiving.
          initialPayment: 1500,
        }),
    ).expect(400);
  });
});
