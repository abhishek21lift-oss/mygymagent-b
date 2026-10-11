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
    const result = await createTestApp();
    app = result.app;
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
    if (app) {
      await app.close().catch(() => {});
    }
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

  it('refuses all refunds under the strict no-refund policy', async () => {
    const payment = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        amount: 200,
      }),
    ).expect(201);
    const paymentId = payment.body.data.id;

    // Partial, full and repeated attempts all answer 410 Gone: payments
    // are final and non-refundable. The payment itself is untouched.
    for (const body of [
      { amount: 50, reason: 'Partial dissatisfaction' },
      {},
    ]) {
      const refused = await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/payments/${paymentId}/refund`)
          .send(body),
      ).expect(410);
      expect(refused.body.error.message).toMatch(/non-refundable/i);
    }

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/payments/${paymentId}`),
    ).expect(200);
    expect(after.body.data.status).toBe('COMPLETED');
    expect(after.body.data.refunds).toEqual([]);
  });

  it('refuses concurrent refund requests the same way: no refund is ever created', async () => {
    // The old read-then-write race this test used to cover cannot happen
    // anymore -- refund() answers 410 before touching any row, so every
    // concurrent attempt is refused and nothing is ever written.
    const payment = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        amount: 100,
      }),
    ).expect(201);
    const paymentId = payment.body.data.id;

    const attempt = () =>
      request(app.getHttpServer())
        .post(`/payments/${paymentId}/refund`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({});

    const [first, second] = await Promise.all([attempt(), attempt()]);
    expect([first.status, second.status]).toEqual([410, 410]);

    const finalPayment = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/payments/${paymentId}`),
    ).expect(200);
    expect(finalPayment.body.data.status).toBe('COMPLETED');
    expect(finalPayment.body.data.refunds).toEqual([]);
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
