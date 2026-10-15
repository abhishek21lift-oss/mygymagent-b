import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * D-DB01 (F-DB01): member removal must never destroy history.
 *
 * Seeds org + branch + member with a payment, an invoice, and an attendance
 * row, deletes the member through the API, and proves every history row
 * survives while the member itself is soft-deleted (deletedAt + INACTIVE).
 * Then proves the database itself refuses a raw hard delete (ON DELETE
 * RESTRICT from migration 20261014184923_member_history_restrict).
 *
 * Requires the standard e2e prerequisites (Postgres via .env.test, Redis,
 * s3rver). BLOCKED locally until the test database is reachable; runs in CI.
 */
describe('Member delete preserves history (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;
  let memberId: string;
  let paymentId: string;
  let invoiceId: string;
  let attendanceId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const email = `delhist-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Delete History Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Delhist',
      })
      .expect(201);
    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${reg.body.data.accessToken}`)
      .expect(200);
    org = {
      accessToken: reg.body.data.accessToken,
      organizationId: reg.body.data.organization.id,
      userId: reg.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };

    const member = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: org.branchId,
          firstName: 'Hist',
          lastName: `Ory${Date.now()}`,
        }),
    ).expect(201);
    memberId = member.body.data.id;

    const payment = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/payments').send({
        memberId,
        amount: 1500,
        method: 'CASH',
      }),
    ).expect(201);
    paymentId = payment.body.data.id;

    const invoice = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/invoices')
        .send({
          memberId,
          lines: [{ label: 'Monthly fee', amount: 1500, qty: 1 }],
        }),
    ).expect(201);
    invoiceId = invoice.body.data.id;

    const checkin = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/attendance/check-in').send({
        branchId: org.branchId,
        memberId,
        method: 'MANUAL',
      }),
    ).expect((res) => {
      if (![200, 201].includes(res.status))
        throw new Error(`check-in failed: ${res.status}`);
    });
    // Allowed (201, record spread with id) or gate-denied (200 with
    // attendanceId; the member has no membership in this fixture, so the
    // gate denies but still persists the row -- which is all this suite
    // needs for history-preservation purposes).
    attendanceId = checkin.body.data?.id ?? checkin.body.data?.attendanceId;
    expect(attendanceId).toBeDefined();
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('API delete soft-deletes the member and leaves all history rows intact', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).delete(`/members/${memberId}`),
    ).expect(200);

    const member = await prisma.member.findFirst({ where: { id: memberId } });
    expect(member).not.toBeNull();
    expect(member!.deletedAt).not.toBeNull();
    expect(member!.status).toBe('INACTIVE');

    await expect(
      prisma.payment.findFirst({ where: { id: paymentId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.invoice.findFirst({ where: { id: invoiceId } }),
    ).resolves.not.toBeNull();
    await expect(
      prisma.attendance.findFirst({ where: { id: attendanceId } }),
    ).resolves.not.toBeNull();
  });

  it('the database refuses a raw hard delete while history survives (RESTRICT)', async () => {
    await expect(
      prisma.member.delete({ where: { id: memberId } }),
    ).rejects.toMatchObject({
      code: 'P2003',
    });
    // And the member row is still there afterwards.
    await expect(
      prisma.member.findFirst({ where: { id: memberId } }),
    ).resolves.not.toBeNull();
  });
});
