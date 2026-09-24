import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-6 (BACKLOG.md): trainer commissions, which had no coverage at all.
 *
 * `/payroll/*` is a separate module from `/hr-payroll/*` and, unlike it,
 * is written entirely in raw SQL, has no frontend caller and had no test.
 * That combination is how B-P0-5's kiosk path turned out never to have
 * worked, so the first thing worth establishing here is whether the
 * commission pipeline produces anything at all.
 *
 * The pipeline: a commission rule per trainer, a completed PT session
 * with a price, then generation matching one to the other.
 */
describe('Trainer commissions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerToken: string;
  let organizationId: string;
  let branchId: string;
  let memberId: string;
  let trainerProfileId: string;
  let trainerUserId: string;

  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${ownerToken}`);

  const window = {
    from: new Date(Date.now() - 7 * 86_400_000).toISOString(),
    to: new Date(Date.now() + 7 * 86_400_000).toISOString(),
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Commission Gym',
        email: `commission-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Cleo',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    organizationId = registered.body.data.organization.id;

    const branches = await authed(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const trainer = await authed(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `commission-trainer-${Date.now()}@example.com`,
          firstName: 'Tess',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: trainer.body.data.id },
      data: { status: 'ACTIVE' },
    });
    // Commission rules key off the staff profile, not the user, because a
    // PT session's trainer is a StaffProfile.
    const profile = await prisma.staffProfile.findFirstOrThrow({
      where: { userId: trainer.body.data.id },
      select: { id: true },
    });
    trainerProfileId = profile.id;
    // The payroll endpoint is keyed by userId -- a staff-profile id names
    // nobody outside the HR tables.
    trainerUserId = trainer.body.data.id;

    const member = await authed(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: 'Cass',
        lastName: 'Client',
      }),
    ).expect(201);
    memberId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('stores a commission rule for a trainer', async () => {
    const res = await authed(
      request(app.getHttpServer()).post('/payroll/commission-rules').send({
        trainerId: trainerProfileId,
        percentage: 40,
        fixedAmount: 50,
      }),
    ).expect(201);
    expect(Number(res.body.data.percentage)).toBe(40);
  });

  it('upserts rather than duplicating a rule for the same trainer', async () => {
    await authed(
      request(app.getHttpServer()).post('/payroll/commission-rules').send({
        trainerId: trainerProfileId,
        percentage: 45,
        fixedAmount: 50,
      }),
    ).expect(201);

    const list = await authed(
      request(app.getHttpServer()).get('/payroll/commission-rules'),
    ).expect(200);
    const mine = list.body.data.filter(
      (r: { trainerId: string }) => r.trainerId === trainerProfileId,
    );
    expect(mine).toHaveLength(1);
    expect(Number(mine[0].percentage)).toBe(45);
  });

  it('generates a commission from a completed, priced PT session', async () => {
    const session = await authed(
      request(app.getHttpServer())
        .post('/pt-sessions')
        .send({
          memberId,
          trainerId: trainerProfileId,
          branchId,
          startTime: new Date(Date.now() + 3_600_000).toISOString(),
          endTime: new Date(Date.now() + 7_200_000).toISOString(),
          price: 1000,
        }),
    ).expect(201);

    // Only completed sessions earn commission.
    await prisma.ptSession.update({
      where: { id: session.body.data.id },
      data: { status: 'COMPLETED' },
    });

    const generated = await authed(
      request(app.getHttpServer())
        .post('/payroll/commissions/generate')
        .send(window),
    ).expect(201);

    expect(generated.body.data.scanned).toBeGreaterThanOrEqual(1);
    expect(generated.body.data.created).toBe(1);

    const list = await authed(
      request(app.getHttpServer()).get('/payroll/commissions'),
    ).expect(200);
    const row = list.body.data.find(
      (c: { ptSessionId: string }) => c.ptSessionId === session.body.data.id,
    );
    expect(row).toBeTruthy();
    // 45% of 1000, plus the 50 flat component.
    expect(Number(row.commissionAmount)).toBe(500);
    expect(row.status).toBe('PENDING');
  });

  it('does not double-pay a session that already has a commission', async () => {
    const again = await authed(
      request(app.getHttpServer())
        .post('/payroll/commissions/generate')
        .send(window),
    ).expect(201);
    expect(again.body.data.created).toBe(0);
  });

  it('approves pending commissions when the payroll run covering them is processed', async () => {
    // B-P0-6: commission approval used to hang off a second pay-cycle
    // object (`PayrollPeriod`). It now happens as part of processing the
    // payroll run for the same window, so there is one pay cycle rather
    // than two that could disagree about whether a window is closed.
    // Items are generated when the run is created, so the trainer has to
    // be payroll-enabled first or the run has nothing to finalize.
    await authed(
      request(app.getHttpServer())
        .patch(`/hr-payroll/staff/${trainerUserId}`)
        .send({
          payrollEnabled: true,
          salaryType: 'MONTHLY',
          baseSalary: 30000,
        }),
    ).expect(200);

    const run = await authed(
      request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
        periodStart: window.from,
        periodEnd: window.to,
      }),
    ).expect(201);
    const runId = run.body.data.id;

    await authed(
      request(app.getHttpServer()).post(
        `/hr-payroll/payroll-runs/${runId}/approve`,
      ),
    ).expect(201);
    await authed(
      request(app.getHttpServer()).post(
        `/hr-payroll/payroll-runs/${runId}/process`,
      ),
    ).expect(201);

    const list = await authed(
      request(app.getHttpServer()).get('/payroll/commissions'),
    ).expect(200);
    expect(list.body.data.length).toBeGreaterThan(0);
    expect(
      list.body.data.every((c: { status: string }) => c.status === 'APPROVED'),
    ).toBe(true);
  });

  it('keeps every row inside the caller organization', async () => {
    const rows = await prisma.trainerCommission.findMany({
      where: { organizationId },
      select: { organizationId: true },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.organizationId === organizationId)).toBe(true);
  });
});
