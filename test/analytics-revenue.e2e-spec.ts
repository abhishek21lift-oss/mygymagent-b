import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

interface RevenueByCurrency {
  currency: string;
  paymentCount: number;
  grossRevenue: string;
  membershipRevenue: string;
  otherRevenue: string;
  refunded: string;
  netRevenue: string;
}

/** Exercises FinanceService.getRevenueSummary() against real Postgres --
 * see src/analytics/README.md for the exact definitions being tested. */
describe('Analytics / revenue (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;

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

  beforeAll(async () => {
    app = await createTestApp();
    org = await registerOrg('Revenue Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('splits gross revenue into membership vs. other, and nets out refunds', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Revenue',
        lastName: 'Member',
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Standard', durationDays: 30, price: 100 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    // Membership revenue: 100 (paid in full).
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        membershipId: membership.body.data.id,
        amount: 100,
      }),
    ).expect(201);

    // Other (one-off, no membershipId) revenue: 30, then a 10 refund.
    const oneOff = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        amount: 30,
      }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/payments/${oneOff.body.data.id}/refund`)
        .send({ amount: 10 }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/revenue'),
    ).expect(200);

    const usd = (res.body.data.revenue as RevenueByCurrency[]).find(
      (r) => r.currency === 'USD',
    );
    expect(usd).toBeDefined();
    expect(usd!.grossRevenue).toBe('130.00');
    expect(usd!.membershipRevenue).toBe('100.00');
    expect(usd!.otherRevenue).toBe('30.00');
    expect(usd!.refunded).toBe('10.00');
    expect(usd!.netRevenue).toBe('120.00');
  });

  it('keeps payments in different currencies in separate buckets, never summed together', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Euro',
        lastName: 'Member',
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        amount: 50,
        currency: 'EUR',
      }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/revenue'),
    ).expect(200);

    const revenue = res.body.data.revenue as RevenueByCurrency[];
    const eur = revenue.find((r) => r.currency === 'EUR');
    const usd = revenue.find((r) => r.currency === 'USD');
    expect(eur?.grossRevenue).toBe('50.00');
    // The USD bucket from the previous test must be unaffected by the
    // EUR payment -- proves they're never summed into one figure.
    expect(usd?.grossRevenue).toBe('130.00');
  });

  it('reports an outstanding balance for a short-paid membership, and names what it cannot compute', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Short',
        lastName: 'Payer',
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Balance Plan', durationDays: 30, price: 80 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: member.body.data.id,
        membershipId: membership.body.data.id,
        amount: 20,
      }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/revenue'),
    ).expect(200);

    const outstandingUsd = res.body.data.outstanding.find(
      (o: { currency: string }) => o.currency === 'USD',
    );
    expect(outstandingUsd).toBeDefined();
    expect(Number(outstandingUsd.outstandingBalance)).toBeGreaterThanOrEqual(
      60,
    );

    const notComputableKeys = res.body.data.notComputable.map(
      (n: { key: string }) => n.key,
    );
    expect(notComputableKeys).toEqual(
      expect.arrayContaining([
        'productRevenue',
        'ptRevenue',
        'discounts',
        'expenses',
        'payroll',
        'commissions',
      ]),
    );
  });

  it('rejects an invalid date on the from/to query params', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/analytics/revenue')
        .query({ from: 'not-a-date' }),
    ).expect(400);
  });
});
