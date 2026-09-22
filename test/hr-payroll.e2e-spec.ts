import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-2 (BACKLOG.md): first e2e coverage for src/hr-payroll/ -- leave
 * types, leave requests with balance accounting, and the payroll run
 * DRAFT -> APPROVED -> PROCESSED lifecycle. Money-adjacent and entirely
 * untested before this file.
 *
 * Salary fields are set through Prisma rather than over HTTP because no
 * endpoint writes them yet: POST /users creates a StaffProfile but its DTO
 * has no salaryType/baseSalary/payrollEnabled, so payroll can only be run
 * for staff whose salary was populated out of band. That gap is real (and
 * worth its own backlog item); this fixture documents it rather than
 * hiding it.
 */
describe('HR & payroll (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let otherBranchId: string;
  let staffProfileId: string;
  let limitedToken: string;
  let paidLeaveTypeId: string;
  let approvedRequestId: string;
  let runId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asLimited = (req: request.Test) => authed(limitedToken)(req);

  const day = (offset: number) =>
    new Date(Date.UTC(2026, 5, 1 + offset)).toISOString().slice(0, 10);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'HR Payroll Test Gym',
        email: `hr-payroll-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'HR',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const other = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'Payroll Branch B', slug: `payroll-b-${Date.now()}` }),
    ).expect(201);
    otherBranchId = other.body.data.id;

    const staff = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `hr-staff-${Date.now()}@example.com`,
          firstName: 'Sam',
          lastName: 'Staff',
          primaryBranchId: branchId,
          roleKey: 'STAFF',
          roleBranchId: branchId,
          jobTitle: 'Floor coach',
        }),
    ).expect(201);
    const profile = await prisma.staffProfile.findFirstOrThrow({
      where: { userId: staff.body.data.id },
      select: { id: true },
    });
    staffProfileId = profile.id;
    await prisma.staffProfile.update({
      where: { id: staffProfileId },
      data: {
        payrollEnabled: true,
        salaryType: 'MONTHLY',
        baseSalary: 30000,
      },
    });

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `hr-accountant-${Date.now()}@example.com`,
          firstName: 'Limited',
          lastName: 'Accountant',
          primaryBranchId: branchId,
          roleKey: 'ACCOUNTANT',
          roleBranchId: branchId,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    limitedToken = app.get(TokensService).signAccessToken(invited.body.data.id);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('leave types', () => {
    it('creates a paid leave type with an annual quota', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/leave-types').send({
          name: 'Annual leave',
          code: 'annual',
          paid: true,
          annualQuota: 12,
        }),
      ).expect(201);
      paidLeaveTypeId = res.body.data.id;
      expect(res.body.data.code).toBe('ANNUAL');
      expect(res.body.data.paid).toBe(true);
    });

    it('rejects a duplicate code in the same scope', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/leave-types').send({
          name: 'Annual leave again',
          code: 'ANNUAL',
        }),
      ).expect(409);
    });

    it('lists active leave types', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/hr-payroll/leave-types'),
      ).expect(200);
      expect(
        res.body.data.some((t: { id: string }) => t.id === paidLeaveTypeId),
      ).toBe(true);
    });

    it('denies a caller without hr.read', async () => {
      await asLimited(
        request(app.getHttpServer()).get('/hr-payroll/leave-types'),
      ).expect(403);
    });
  });

  describe('leave requests', () => {
    it('creates a pending request for the staff member', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .post('/hr-payroll/leave-requests')
          .send({
            staffProfileId,
            leaveTypeId: paidLeaveTypeId,
            branchId,
            startDate: day(10),
            endDate: day(11),
            unit: 'DAY',
            days: 1,
            reason: 'Family event',
          }),
      ).expect(201);
      approvedRequestId = res.body.data.id;
      expect(res.body.data.status).toBe('PENDING');
    });

    it('rejects a request whose branch does not match the staff branch', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/hr-payroll/leave-requests')
          .send({
            staffProfileId,
            leaveTypeId: paidLeaveTypeId,
            branchId: otherBranchId,
            startDate: day(20),
            endDate: day(21),
            unit: 'DAY',
            days: 1,
          }),
      ).expect(400);
    });

    it('rejects a half-day request longer than half a day', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/hr-payroll/leave-requests')
          .send({
            staffProfileId,
            leaveTypeId: paidLeaveTypeId,
            branchId,
            startDate: day(30),
            endDate: day(30),
            unit: 'HALF_DAY',
            days: 1,
          }),
      ).expect(400);
    });

    it('approves the request and draws the days down from the balance', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/leave-requests/${approvedRequestId}/review`)
          .send({ status: 'APPROVED', note: 'Enjoy' }),
      ).expect(200);
      expect(res.body.data.status).toBe('APPROVED');
      expect(res.body.data.reviewedAt).toBeTruthy();

      const balance = await prisma.leaveBalance.findFirstOrThrow({
        where: { staffProfileId, leaveTypeId: paidLeaveTypeId },
      });
      expect(Number(balance.accrued)).toBe(12);
      expect(Number(balance.used)).toBe(1);
      expect(Number(balance.closing)).toBe(11);
    });

    it('rejects re-reviewing an already-decided request', async () => {
      await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/leave-requests/${approvedRequestId}/review`)
          .send({ status: 'REJECTED' }),
      ).expect(404);
    });

    it('rejects a new request overlapping an approved one', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/hr-payroll/leave-requests')
          .send({
            staffProfileId,
            leaveTypeId: paidLeaveTypeId,
            branchId,
            startDate: day(11),
            endDate: day(12),
            unit: 'DAY',
            days: 1,
          }),
      ).expect(409);
    });

    it('refuses to approve more days than the balance allows', async () => {
      const oversized = await asOwner(
        request(app.getHttpServer())
          .post('/hr-payroll/leave-requests')
          .send({
            staffProfileId,
            leaveTypeId: paidLeaveTypeId,
            branchId,
            startDate: day(40),
            endDate: day(60),
            unit: 'DAY',
            days: 20,
          }),
      ).expect(201);

      await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/leave-requests/${oversized.body.data.id}/review`)
          .send({ status: 'APPROVED' }),
      ).expect(400);
    });

    it('filters the list by status and rejects an unknown status', async () => {
      const approved = await asOwner(
        request(app.getHttpServer())
          .get('/hr-payroll/leave-requests')
          .query({ status: 'APPROVED' }),
      ).expect(200);
      expect(
        approved.body.data.some(
          (r: { id: string }) => r.id === approvedRequestId,
        ),
      ).toBe(true);
      expect(
        approved.body.data.every(
          (r: { status: string }) => r.status === 'APPROVED',
        ),
      ).toBe(true);

      await asOwner(
        request(app.getHttpServer())
          .get('/hr-payroll/leave-requests')
          .query({ status: 'MAYBE' }),
      ).expect(400);
    });
  });

  describe('payroll runs', () => {
    it('generates a draft run with one item per payroll-enabled staff member', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
          branchId,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
          notes: 'January run',
        }),
      ).expect(201);
      runId = res.body.data.id;
      expect(res.body.data.status).toBe('DRAFT');
      expect(res.body.data.items).toHaveLength(1);
      const item = res.body.data.items[0];
      expect(item.staffProfileId).toBe(staffProfileId);
      expect(Number(item.gross)).toBe(30000);
      expect(Number(item.net)).toBe(30000);
      expect(Number(item.payableDays)).toBe(31);
    });

    it('rejects a duplicate run for the same branch and period', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
          branchId,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        }),
      ).expect(409);
    });

    it('rejects a run for a scope with no payroll-enabled staff', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
          branchId: otherBranchId,
          periodStart: '2026-01-01',
          periodEnd: '2026-01-31',
        }),
      ).expect(400);
    });

    it('rejects an inverted payroll period', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
          branchId,
          periodStart: '2026-03-31',
          periodEnd: '2026-03-01',
        }),
      ).expect(400);
    });

    it('recomputes gross and net when an item is adjusted', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/payroll-runs/${runId}/items`)
          .send({
            staffProfileId,
            overtime: 1000,
            incentives: 500,
            deductions: 200,
            unpaidLeave: 300,
            notes: 'Covered two extra shifts',
          }),
      ).expect(200);
      // gross = base 30000 + overtime 1000 + incentives 500
      expect(Number(res.body.data.gross)).toBe(31500);
      // net = gross - deductions 200 - unpaid leave 300
      expect(Number(res.body.data.net)).toBe(31000);
    });

    it('rejects adjusting an item for staff outside the run', async () => {
      await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/payroll-runs/${runId}/items`)
          .send({
            staffProfileId: '00000000-0000-4000-8000-000000000000',
            overtime: 10,
          }),
      ).expect(404);
    });

    it('approves the run, then refuses further item edits', async () => {
      const approved = await asOwner(
        request(app.getHttpServer()).post(
          `/hr-payroll/payroll-runs/${runId}/approve`,
        ),
      ).expect(201);
      expect(approved.body.data.status).toBe('APPROVED');
      expect(approved.body.data.approvedAt).toBeTruthy();

      await asOwner(
        request(app.getHttpServer())
          .patch(`/hr-payroll/payroll-runs/${runId}/items`)
          .send({ staffProfileId, overtime: 50 }),
      ).expect(404);

      await asOwner(
        request(app.getHttpServer()).post(
          `/hr-payroll/payroll-runs/${runId}/approve`,
        ),
      ).expect(404);
    });

    it('processes the run and finalizes its items exactly once', async () => {
      const processed = await asOwner(
        request(app.getHttpServer()).post(
          `/hr-payroll/payroll-runs/${runId}/process`,
        ),
      ).expect(201);
      expect(processed.body.data.status).toBe('PROCESSED');
      expect(processed.body.data.processedAt).toBeTruthy();

      const items = await prisma.payrollItem.findMany({
        where: { payrollRunId: runId },
        select: { status: true },
      });
      expect(items).toHaveLength(1);
      expect(items[0].status).toBe('FINALIZED');

      await asOwner(
        request(app.getHttpServer()).post(
          `/hr-payroll/payroll-runs/${runId}/process`,
        ),
      ).expect(404);
    });

    it('lists runs with their items and staff identity', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/hr-payroll/payroll-runs'),
      ).expect(200);
      const run = res.body.data.find((r: { id: string }) => r.id === runId);
      expect(run).toBeDefined();
      expect(run.status).toBe('PROCESSED');
      expect(run.items[0].staffProfile.user.firstName).toBe('Sam');
    });

    it('denies a caller without payroll.manage', async () => {
      await asLimited(
        request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
          branchId,
          periodStart: '2026-02-01',
          periodEnd: '2026-02-28',
        }),
      ).expect(403);
    });
  });
});
