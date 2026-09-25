import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * PT session booking had no e2e coverage at all, which is how B-P0-7
 * nearly shipped a regression: `BookPtSessionDto.startTime` is `@IsDate()`,
 * JSON has no date type, and the ISO string a client actually sends was
 * only becoming a `Date` because `enableImplicitConversion` happened to
 * convert it. Removing that option without an explicit `@Type(() => Date)`
 * turns every booking into a 400, and nothing in the suite would have
 * said so.
 */
describe('PT sessions (e2e)', () => {
  let app: INestApplication;
  let ownerToken: string;
  let branchId: string;
  let memberId: string;

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${ownerToken}`);

  const startTime = new Date(Date.now() + 86_400_000);
  const endTime = new Date(startTime.getTime() + 3_600_000);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'PT Session Gym',
        email: `pt-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Pat',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await authed(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const member = await authed(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Pia',
        lastName: 'Member',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('books a session from ISO date strings, which is all JSON can carry', async () => {
    const res = await authed(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      }),
    ).expect(201);

    expect(res.body.data.id).toBeTruthy();
    expect(new Date(res.body.data.startTime).toISOString()).toBe(
      startTime.toISOString(),
    );
  });

  it('rejects a start time that is not a date at all', async () => {
    await authed(
      request(app.getHttpServer()).post('/pt-sessions').send({
        memberId,
        branchId,
        startTime: 'next tuesday',
        endTime: endTime.toISOString(),
      }),
    ).expect(400);
  });

  it('lists the booked session', async () => {
    const res = await authed(
      request(app.getHttpServer()).get('/pt-sessions'),
    ).expect(200);
    expect(res.body.data.items.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by memberId, which the global pipe used to reject outright', async () => {
    // This is the production bug: the handler took `@Query()
    // PaginationQueryDto` plus separate `@Query('memberId')` params, and
    // the global pipe validates the whole query object against the DTO
    // with `forbidNonWhitelisted: true`. The DTO declared none of the
    // filters, so every filtered request 400'd before the handler ran --
    // which is the PT panel on every member's page. The suite never
    // caught it because it only ever listed without a filter.
    const res = await authed(
      request(app.getHttpServer()).get('/pt-sessions').query({ memberId }),
    ).expect(200);
    expect(
      res.body.data.items.every(
        (s: { memberId: string }) => s.memberId === memberId,
      ),
    ).toBe(true);
  });

  it('accepts every documented filter together', async () => {
    await authed(
      request(app.getHttpServer())
        .get('/pt-sessions')
        .query({
          memberId,
          branchId,
          startFrom: new Date(Date.now() - 86_400_000).toISOString(),
          endTo: new Date(Date.now() + 7 * 86_400_000).toISOString(),
          page: 1,
          pageSize: 10,
        }),
    ).expect(200);
  });

  it('still rejects a filter that is not a uuid', async () => {
    // Typing the filters is the other half of the fix: `memberId` was an
    // unchecked string reaching a Prisma `where`.
    await authed(
      request(app.getHttpServer())
        .get('/pt-sessions')
        .query({ memberId: 'not-a-uuid' }),
    ).expect(400);
  });

  it('still rejects a query param nobody declared', async () => {
    await authed(
      request(app.getHttpServer()).get('/pt-sessions').query({ nonsense: '1' }),
    ).expect(400);
  });
});
