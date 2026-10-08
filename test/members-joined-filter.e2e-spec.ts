import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * "Joined from / to" are days at the gym, both ends inclusive. The
 * dashboard's "New clients" asks for today; in India the UTC day ends at
 * 05:30, so reading the dates as UTC put everyone who joined before then
 * on the previous day, and "to" left out its own day entirely.
 */
describe('Members join-date filter (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let token: string;
  let lateNight: string;
  let afternoon: string;

  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const joined = async (from: string, to: string) => {
    const res = await as(
      request(app.getHttpServer())
        .get('/members')
        .query({ joinedFrom: from, joinedTo: to, pageSize: 100 }),
    ).expect(200);
    return (res.body.data.items as { id: string }[]).map((m) => m.id);
  };

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Join Day Gym',
        email: `joined-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Joined',
      })
      .expect(201);
    token = reg.body.data.accessToken;
    await prisma.organization.update({
      where: { id: reg.body.data.user.organizationId },
      data: { timezone: 'Asia/Kolkata' },
    });
    const branchId = (
      await as(request(app.getHttpServer()).get('/branches')).expect(200)
    ).body.data.items[0].id;

    const member = async (firstName: string, joinedAt: string) => {
      const res = await as(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName,
          lastName: 'Member',
        }),
      ).expect(201);
      await prisma.member.update({
        where: { id: res.body.data.id },
        data: { joinedAt: new Date(joinedAt) },
      });
      return res.body.data.id as string;
    };
    // 9 Oct 01:30 IST, which is still 8 Oct in UTC.
    lateNight = await member('Late', '2026-10-08T20:00:00.000Z');
    // 8 Oct 15:30 IST.
    afternoon = await member('Noon', '2026-10-08T10:00:00.000Z');
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('counts a join on the day it was at the gym', async () => {
    expect(await joined('2026-10-08', '2026-10-08')).toEqual([afternoon]);
    expect(await joined('2026-10-09', '2026-10-09')).toEqual([lateNight]);
  });

  it('includes the whole of the "to" day', async () => {
    expect((await joined('2026-10-08', '2026-10-09')).sort()).toEqual(
      [afternoon, lateNight].sort(),
    );
  });
});
