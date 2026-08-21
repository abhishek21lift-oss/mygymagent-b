import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Payments (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let memberId: string;

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
    org = await registerOrg('Payments Test Gym');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Paying',
        lastName: 'Member',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('records a one-off payment not linked to any membership', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        amount: 100,
        method: 'CARD',
        note: 'Drop-in PT session',
      }),
    ).expect(201);

    expect(res.body.data.amount).toBe('100');
    expect(res.body.data.currency).toBe('USD');
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.membershipId).toBeNull();
  });

  it('filters the list by memberId without rejecting the extra query param', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/payments').query({ memberId }),
    ).expect(200);
    expect(
      res.body.data.items.every(
        (p: { memberId: string }) => p.memberId === memberId,
      ),
    ).toBe(true);
  });

  it('rejects a payment for a membership that belongs to a different member', async () => {
    const otherMember = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Other',
        lastName: 'Member',
      }),
    ).expect(201);

    const plan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/membership-plans')
        .send({ name: 'Monthly', durationDays: 30, price: 49.99 }),
    ).expect(201);

    const membership = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/memberships').send({
        memberId: otherMember.body.data.id,
        membershipPlanId: plan.body.data.id,
      }),
    ).expect(201);

    // memberId belongs to `memberId` (top-level test member), but the
    // membershipId belongs to otherMember -- must be rejected, not silently
    // linked to the wrong member's history.
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        membershipId: membership.body.data.id,
        amount: 49.99,
      }),
    ).expect(400);
  });

  it('supports partial refunds up to the original amount, then rejects going over', async () => {
    const payment = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        amount: 200,
      }),
    ).expect(201);
    const paymentId = payment.body.data.id;

    const firstRefund = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/payments/${paymentId}/refund`)
        .send({ amount: 50, reason: 'Partial dissatisfaction' }),
    ).expect(201);
    expect(firstRefund.body.data.amount).toBe('50');

    const afterFirst = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/payments/${paymentId}`),
    ).expect(200);
    expect(afterFirst.body.data.status).toBe('PARTIALLY_REFUNDED');

    // Attempting to refund more than the remaining 150 is rejected.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/payments/${paymentId}/refund`)
        .send({ amount: 151 }),
    ).expect(400);

    // Refunding exactly the remaining balance (omit amount = full
    // remaining) succeeds and flips status to fully REFUNDED.
    await authed(org.accessToken)(
      request(app.getHttpServer()).post(`/payments/${paymentId}/refund`),
    ).expect(201);

    const afterFull = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/payments/${paymentId}`),
    ).expect(200);
    expect(afterFull.body.data.status).toBe('REFUNDED');

    // A payment that's already fully refunded cannot be refunded again.
    await authed(org.accessToken)(
      request(app.getHttpServer()).post(`/payments/${paymentId}/refund`),
    ).expect(400);
  });

  it('rejects recording a payment for a member that does not exist', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId: '00000000-0000-0000-0000-000000000000',
        amount: 10,
      }),
    ).expect(404);
  });
});
