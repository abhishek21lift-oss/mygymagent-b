import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { OwnerOsService } from '../src/briefing/owner-os.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * "Today" means one thing everywhere. The dashboard's tiles, the daily
 * briefing, the COO page and the AI agent's owner briefing used to count
 * it four ways (a UTC date, staff check-ins, revenue without product
 * sales, branches by different columns), so the agent could quote a
 * figure the owner's screen contradicted. After one day of activity they
 * must all agree with the endpoints behind the dashboard's tiles.
 */
describe("Today's figures agree everywhere (e2e)", () => {
  let app: INestApplication;
  let token: string;
  let organizationId: string;
  let branchId: string;
  let userId: string;

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = (await createTestApp()).app;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Same Numbers Gym',
        email: `today-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Today',
      })
      .expect(201);
    token = reg.body.data.accessToken;
    organizationId = reg.body.data.organization.id;
    userId = reg.body.data.user.id;
    branchId = (await as(request(server()).get('/branches')).expect(200)).body
      .data.items[0].id;

    // A day at the gym: two new members, one paying in part, both
    // checking in; one turned away; a staff check-in; a refund; a lead.
    const member = async (firstName: string) =>
      (
        await as(
          request(server()).post('/members').send({
            primaryBranchId: branchId,
            firstName,
            lastName: 'Today',
          }),
        ).expect(201)
      ).body.data.id as string;
    const first = await member('First');
    const second = await member('Second');
    const turnedAway = await member('Unpaid');
    for (const id of [first, second]) {
      const { membershipId } = await grantActiveMembership(app, token, id);
      await as(
        request(server()).post('/payments').send({
          memberId: id,
          membershipId,
          amount: 30,
          method: 'CASH',
        }),
      ).expect(201);
      await as(
        request(server())
          .post('/attendance/check-in')
          .send({ memberId: id, branchId }),
      ).expect(201);
    }
    await as(
      request(server())
        .post('/attendance/check-in')
        .send({ memberId: turnedAway, branchId }),
    ).expect(200);
    await as(
      request(server())
        .post('/attendance/check-in')
        .send({ staffUserId: userId, branchId }),
    ).expect(201);
    const refunded = await as(
      request(server()).post('/payments').send({ memberId: first, amount: 10 }),
    ).expect(201);
    await as(
      request(server())
        .post(`/payments/${refunded.body.data.id}/refund`)
        .send({}),
    ).expect(201);
    await as(
      request(server())
        .post('/leads')
        .send({ firstName: 'Walk', lastName: 'In', phone: '9876500011' }),
    ).expect(201);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('gives the same today to the dashboard, the briefing, the COO page and the AI agent', async () => {
    const daily = (
      await as(request(server()).get('/briefing/daily')).expect(200)
    ).body.data;
    const today = daily.today;
    expect(today).toMatchObject({
      checkIns: 2,
      deniedCheckIns: 1,
      newMembers: 3,
      leads: 1,
    });

    // The dashboard's tiles, from their own endpoints.
    const members = await as(
      request(server())
        .get('/members')
        .query({ joinedFrom: today.date, joinedTo: today.date, pageSize: 1 }),
    ).expect(200);
    expect(members.body.data.total).toBe(today.newMembers);
    const revenue = await as(
      request(server())
        .get('/analytics/revenue')
        .query({ from: today.date, to: today.date }),
    ).expect(200);
    const row = revenue.body.data.revenue.find(
      (r: { currency: string }) => r.currency === today.currency,
    );
    expect(Number(row.grossRevenue)).toBe(today.collected);
    expect(Number(row.netRevenue)).toBe(today.net);
    expect(today.net).toBe(today.collected - 10);

    const coo = (
      await as(request(server()).get('/analytics/coo-briefing')).expect(200)
    ).body.data.today;
    expect(coo).toMatchObject({
      date: today.date,
      checkIns: today.checkIns,
      collected: today.collected.toFixed(2),
      revenueNet: today.net.toFixed(2),
      currency: today.currency,
    });

    const owner = await app.get(OwnerOsService).getBriefing(organizationId);
    expect(owner.currency).toBe(today.currency);
    expect(owner.metrics.todayAttendance).toBe(today.checkIns);
    expect(owner.metrics.todayRevenue).toBe(today.net);
    expect(owner.metrics.expiringSoon).toBe(daily.expiringSoon.count);
    const owed = daily.revenue.outstanding.find(
      (o: { currency: string }) => o.currency === today.currency,
    );
    expect(owner.metrics.outstandingPayments).toBe(
      owed ? Number(owed.outstandingBalance) : 0,
    );
  });

  it('keeps one branch to its own numbers', async () => {
    const other = '00000000-0000-4000-8000-000000000000';
    const daily = (
      await as(
        request(server()).get('/briefing/daily').query({ branchId: other }),
      ).expect(200)
    ).body.data;
    expect(daily.today).toMatchObject({
      checkIns: 0,
      newMembers: 0,
      collected: 0,
      leads: 0,
    });
  });
});
