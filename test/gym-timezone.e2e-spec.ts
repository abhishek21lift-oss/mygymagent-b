import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { startOfZonedDay, startOfZonedMonth } from '../src/common/time/zoned';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const IST = 'Asia/Kolkata';
const HOUR = 60 * 60 * 1000;

/**
 * Days and months are the gym's, not UTC's. In India a UTC day starts at
 * 05:30, so the first hours of each month were counted in the last, an
 * expense entered today fell outside "up to today", and a membership
 * started on a date began at 05:30 that morning.
 */
describe('Gym timezone (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(gym.accessToken);

  /** Today's date in India, as the app sends it ("2026-10-01"). */
  function todayInIndia(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: IST }).format(
      new Date(),
    );
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Timezone Gym',
        email: `timezone-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: (await as(token).get('/branches').expect(200)).body.data
        .items[0].id,
    };
    await owner()
      .patch('/organizations/current')
      .send({ timezone: IST, currency: 'INR' })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it("counts a payment from the first hour of the gym's month in this month", async () => {
    const member = await owner()
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName: 'Early',
        lastName: 'Bird',
      })
      .expect(201);
    const pay = async (amount: number, at: Date) => {
      const created = await owner()
        .post('/payments')
        .send({ memberId: member.body.data.id, amount, method: 'CASH' })
        .expect(201);
      await prisma.payment.update({
        where: { id: created.body.data.id },
        data: { createdAt: at },
      });
    };
    const monthStart = startOfZonedMonth(new Date(), IST);
    // 01:00 IST on the 1st -- still the previous day in UTC -- belongs to
    // this month; 23:00 IST on the last day of the previous month doesn't.
    // Together they fail a UTC month whichever side of it the clock is on.
    await pay(777, new Date(monthStart.getTime() + HOUR));
    await pay(111, new Date(monthStart.getTime() - HOUR));

    const summary = await owner().get('/analytics/revenue').expect(200);
    const inr = summary.body.data.revenue.find(
      (r: { currency: string }) => r.currency === 'INR',
    );
    expect(Number(inr?.grossRevenue ?? 0)).toBe(777);

    const trend = await owner()
      .get('/analytics/revenue/trend?months=2')
      .expect(200);
    const months = trend.body.data as {
      month: string;
      revenue: { grossRevenue: string }[];
    }[];
    const thisMonth = todayInIndia().slice(0, 7);
    expect(months.map((m) => m.month)).toContain(thisMonth);
    expect(
      Number(
        months.find((m) => m.month === thisMonth)?.revenue[0]?.grossRevenue,
      ),
    ).toBe(777);
  });

  it("includes today's late expenses in a list up to today", async () => {
    const today = todayInIndia();
    // 23:00 IST today: after UTC midnight of this date, which is where
    // "up to today" used to stop.
    const lateToday = new Date(
      startOfZonedDay(new Date(), IST).getTime() + 23 * HOUR,
    );
    const expense = await owner()
      .post('/expenses')
      .send({
        category: 'rent',
        amount: 500,
        expenseDate: lateToday.toISOString(),
      })
      .expect(201);
    const res = await owner()
      .get(`/expenses?from=${today}&to=${today}`)
      .expect(200);
    const ids = res.body.data.items.map((e: { id: string }) => e.id);
    expect(ids).toContain(expense.body.data.id);
  });

  it("starts a membership at midnight on the gym's date", async () => {
    const member = await owner()
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName: 'Dated',
        lastName: 'Start',
      })
      .expect(201);
    const plan = await owner()
      .post('/membership-plans')
      .send({ name: 'Month', durationDays: 30, price: 1000 })
      .expect(201);
    const res = await owner()
      .post('/memberships')
      .send({
        memberId: member.body.data.id,
        membershipPlanId: plan.body.data.id,
        startDate: '2026-11-01',
      })
      .expect(201);
    expect(res.body.data.startDate).toBe('2026-10-31T18:30:00.000Z');
  });
});
