import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * The dashboard's "Outstanding amount" opens the memberships behind it.
 * The list and the total come from one calculation, so they must agree:
 * a part-paid membership is listed with what is left, a fully paid one is
 * not, and the list sums to the revenue summary's outstanding total.
 */
describe('Outstanding memberships list (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let branchId: string;
  let owingMemberId: string;
  let paidMemberId: string;

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = (await createTestApp()).app;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Outstanding Gym',
        email: `outstanding-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Outstanding',
      })
      .expect(201);
    token = reg.body.data.accessToken;
    branchId = (await as(request(server()).get('/branches')).expect(200)).body
      .data.items[0].id;

    const member = async (firstName: string) =>
      (
        await as(
          request(server()).post('/members').send({
            primaryBranchId: branchId,
            firstName,
            lastName: 'Member',
          }),
        ).expect(201)
      ).body.data.id as string;
    owingMemberId = await member('Owing');
    paidMemberId = await member('Paid');

    // Plans from the helper cost 50.
    const owing = await grantActiveMembership(app, token, owingMemberId);
    await as(
      request(server()).post('/payments').send({
        memberId: owingMemberId,
        membershipId: owing.membershipId,
        amount: 20,
        method: 'CASH',
      }),
    ).expect(201);

    const paid = await grantActiveMembership(app, token, paidMemberId);
    await as(
      request(server()).post('/payments').send({
        memberId: paidMemberId,
        membershipId: paid.membershipId,
        amount: 50,
        method: 'UPI',
      }),
    ).expect(201);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  type Row = {
    member: { id: string };
    price: string;
    paid: string;
    outstanding: string;
    currency: string;
  };

  it('lists who owes and how much, and leaves out the paid-up', async () => {
    const res = await as(
      request(server()).get('/analytics/outstanding'),
    ).expect(200);
    const rows = res.body.data as Row[];
    const owing = rows.find((r) => r.member.id === owingMemberId);
    expect(owing).toMatchObject({
      price: '50.00',
      paid: '20.00',
      outstanding: '30.00',
    });
    expect(rows.some((r) => r.member.id === paidMemberId)).toBe(false);
  });

  it('adds up to the outstanding total the dashboard shows', async () => {
    const [list, summary] = await Promise.all([
      as(request(server()).get('/analytics/outstanding')).expect(200),
      as(request(server()).get('/analytics/revenue')).expect(200),
    ]);
    const rows = list.body.data as Row[];
    for (const total of summary.body.data.outstanding as {
      currency: string;
      membershipsWithBalance: number;
      outstandingBalance: string;
    }[]) {
      const mine = rows.filter((r) => r.currency === total.currency);
      expect(mine).toHaveLength(total.membershipsWithBalance);
      expect(
        mine.reduce((sum, r) => sum + Number(r.outstanding), 0).toFixed(2),
      ).toBe(total.outstandingBalance);
    }
  });

  it('narrows to a branch', async () => {
    const other = await as(
      request(server())
        .get('/analytics/outstanding')
        .query({ branchId: '00000000-0000-4000-8000-000000000000' }),
    ).expect(200);
    expect(other.body.data).toHaveLength(0);
  });
});
