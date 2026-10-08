import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * The dashboard's Today tiles open a list of the records behind each
 * figure. Check-ins and collections are listed by `date` (a day on the
 * gym's own calendar), so the list holds exactly the day the tile counts:
 * today's visits and payments in, yesterday's out, another branch out.
 */
describe('Today drill-down filters (e2e)', () => {
  let app: INestApplication;
  let token: string;
  let branchId: string;
  let memberId: string;

  const IST = 'Asia/Kolkata';
  const gymDay = (offsetDays = 0) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: IST,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(Date.now() + offsetDays * 86_400_000));

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const server = () => app.getHttpServer();

  beforeAll(async () => {
    app = (await createTestApp()).app;
    const reg = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Drilldown Gym',
        email: `drilldown-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Drilldown',
      })
      .expect(201);
    token = reg.body.data.accessToken;
    branchId = (await as(request(server()).get('/branches')).expect(200)).body
      .data.items[0].id;
    await as(
      request(server())
        .patch('/organizations/current')
        .send({ timezone: IST, currency: 'INR' }),
    ).expect(200);

    memberId = (
      await as(
        request(server()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Today',
          lastName: 'Visitor',
        }),
      ).expect(201)
    ).body.data.id;
    await grantActiveMembership(app, token, memberId);
    await as(
      request(server())
        .post('/attendance/check-in')
        .send({ memberId, branchId }),
    ).expect(201);
    await as(
      request(server())
        .post('/payments')
        .send({ memberId, amount: 1500, method: 'UPI' }),
    ).expect(201);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  const ids = (res: request.Response) =>
    (res.body.data.items as { memberId: string | null }[]).map(
      (row) => row.memberId,
    );

  it("lists the day's check-ins, and not another day's", async () => {
    const today = await as(
      request(server()).get('/attendance').query({ date: gymDay(), branchId }),
    ).expect(200);
    expect(ids(today)).toContain(memberId);

    const yesterday = await as(
      request(server())
        .get('/attendance')
        .query({ date: gymDay(-1) }),
    ).expect(200);
    expect(ids(yesterday)).not.toContain(memberId);
  });

  it("lists the day's payments, narrowed by branch", async () => {
    const today = await as(
      request(server()).get('/payments').query({ date: gymDay(), branchId }),
    ).expect(200);
    expect(ids(today)).toContain(memberId);

    const yesterday = await as(
      request(server())
        .get('/payments')
        .query({ date: gymDay(-1) }),
    ).expect(200);
    expect(ids(yesterday)).not.toContain(memberId);

    const otherBranch = await as(
      request(server()).get('/payments').query({
        date: gymDay(),
        branchId: '00000000-0000-4000-8000-000000000000',
      }),
    ).expect(200);
    expect(otherBranch.body.data.items).toHaveLength(0);
  });

  it('rejects a date that is not a calendar day', async () => {
    await as(
      request(server()).get('/attendance').query({ date: '2026-10-08T00:00' }),
    ).expect(400);
    await as(
      request(server()).get('/payments').query({ date: 'today' }),
    ).expect(400);
  });
});
