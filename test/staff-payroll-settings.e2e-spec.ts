import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P1-7: the write path for staff payroll terms.
 *
 * `processPayrollRun` reads `payrollEnabled`, `salaryType`, `baseSalary`
 * and `hourlyRate` off `StaffProfile`. Nothing in the API wrote any of
 * them -- `CreateUserDto`/`UpdateUserDto` expose none, and no other route
 * touched them -- so on a real deployment a payroll run either found no
 * payroll-enabled staff and 400'd, or computed every payslip from nulls.
 *
 * The cases that matter most here are the refusals. Exposing the columns
 * was a line of code; the point of the endpoint is that an incoherent
 * combination cannot be saved, because `processPayrollRun` falls back to
 * `Decimal(0)` and would otherwise produce a run full of zero-rupee
 * payslips without complaining to anyone.
 */
describe('Staff payroll settings (e2e, B-P1-7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let branchId: string;
  let otherBranchId: string;
  let staffUserId: string;
  let hourlyUserId: string;
  let otherBranchUserId: string;
  let branchManagerToken: string;
  let accountantToken: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);

  const setPayroll = (userId: string, body: Record<string, unknown>) =>
    asOwner(
      request(app.getHttpServer())
        .patch(`/hr-payroll/staff/${userId}`)
        .send(body),
    );

  const inviteStaff = async (
    firstName: string,
    roleKey: string,
    branch = branchId,
  ) => {
    const res = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `payroll-${firstName.toLowerCase()}-${Date.now()}@example.com`,
          firstName,
          lastName: 'Staff',
          primaryBranchId: branch,
          roleKey,
          roleBranchId: branch,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: res.body.data.id },
      data: { status: 'ACTIVE' },
    });
    return res.body.data.id as string;
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Payroll Settings Gym',
        email: `payroll-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Payroll',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;

    const second = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'East Branch', slug: `east-${Date.now()}` }),
    ).expect(201);
    otherBranchId = second.body.data.id;

    staffUserId = await inviteStaff('Monthly', 'STAFF');
    hourlyUserId = await inviteStaff('Hourly', 'STAFF');
    otherBranchUserId = await inviteStaff('Distant', 'STAFF', otherBranchId);

    const manager = await inviteStaff('Manager', 'BRANCH_MANAGER');
    branchManagerToken = app.get(TokensService).signAccessToken(manager);

    const accountant = await inviteStaff('Bean', 'ACCOUNTANT');
    accountantToken = app.get(TokensService).signAccessToken(accountant);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe('refusing a combination that would pay nothing', () => {
    it('will not enable payroll without a salary type', async () => {
      const res = await setPayroll(staffUserId, {
        payrollEnabled: true,
      }).expect(400);
      expect(res.body.error.message).toContain('salaryType');

      const row = await prisma.staffProfile.findFirstOrThrow({
        where: { userId: staffUserId },
        select: { payrollEnabled: true },
      });
      expect(row.payrollEnabled).toBe(false);
    });

    it('will not enable a MONTHLY or DAILY salary with no amount', async () => {
      for (const salaryType of ['MONTHLY', 'DAILY']) {
        const res = await setPayroll(staffUserId, {
          payrollEnabled: true,
          salaryType,
        }).expect(400);
        expect(res.body.error.message).toContain('baseSalary');
      }
    });

    it('will not enable an HOURLY salary with no rate', async () => {
      const res = await setPayroll(hourlyUserId, {
        payrollEnabled: true,
        salaryType: 'HOURLY',
      }).expect(400);
      expect(res.body.error.message).toContain('hourlyRate');
    });

    it('refuses a zero amount as firmly as a missing one', async () => {
      // `processPayrollRun` multiplies baseSalary; zero is the same
      // zero-rupee payslip as null, just written down deliberately.
      await setPayroll(staffUserId, {
        payrollEnabled: true,
        salaryType: 'MONTHLY',
        baseSalary: 0,
      }).expect(400);
    });

    it('rejects a negative amount and an unknown salary type', async () => {
      await setPayroll(staffUserId, { baseSalary: -1 }).expect(400);
      await setPayroll(staffUserId, { salaryType: 'WEEKLY' }).expect(400);
    });
  });

  describe('the terms a payroll run can actually use', () => {
    it('stores a monthly salary and reads it back', async () => {
      const res = await setPayroll(staffUserId, {
        payrollEnabled: true,
        salaryType: 'MONTHLY',
        baseSalary: 42000.5,
        employeeCode: 'EMP-001',
      }).expect(200);

      expect(res.body.data.payrollEnabled).toBe(true);
      expect(res.body.data.salaryType).toBe('MONTHLY');
      expect(Number(res.body.data.baseSalary)).toBe(42000.5);
      expect(res.body.data.employeeCode).toBe('EMP-001');
      // A staff-profile id names nobody -- the row has to carry the person.
      expect(res.body.data.user.id).toBe(staffUserId);
    });

    it('stores an hourly rate', async () => {
      const res = await setPayroll(hourlyUserId, {
        payrollEnabled: true,
        salaryType: 'HOURLY',
        hourlyRate: 350,
      }).expect(200);
      expect(Number(res.body.data.hourlyRate)).toBe(350);
    });

    it('validates the resulting row, not just the patch', async () => {
      // A salary type is already stored, so enabling alone is coherent.
      await setPayroll(staffUserId, { payrollEnabled: false }).expect(200);
      await setPayroll(staffUserId, { payrollEnabled: true }).expect(200);
    });

    it('lets a disabled staff member have no terms at all', async () => {
      // The rules only bind when payroll is on; an unenrolled person is
      // allowed to be blank.
      const spare = await inviteStaff('Spare', 'STAFF');
      await setPayroll(spare, { payrollEnabled: false }).expect(200);
    });

    it('lists who is on payroll, and on what terms', async () => {
      const res = await asOwner(
        request(app.getHttpServer())
          .get('/hr-payroll/staff')
          .query({ payrollEnabledOnly: 'true' }),
      ).expect(200);

      const userIds = res.body.data.items.map(
        (s: { userId: string }) => s.userId,
      );
      expect(userIds).toEqual(
        expect.arrayContaining([staffUserId, hourlyUserId]),
      );
      expect(
        res.body.data.items.every(
          (s: { payrollEnabled: boolean }) => s.payrollEnabled,
        ),
      ).toBe(true);
    });

    it('does not coerce payrollEnabledOnly=false into true', async () => {
      // B-P0-7 / ADR AI-22: `@Type(() => Boolean)` is `Boolean(value)`,
      // under which "false" is true. This filter uses `@ToBoolean()`, so
      // the disabled staff member must appear.
      const res = await asOwner(
        request(app.getHttpServer())
          .get('/hr-payroll/staff')
          .query({ payrollEnabledOnly: 'false' }),
      ).expect(200);
      expect(
        res.body.data.items.some(
          (s: { payrollEnabled: boolean }) => !s.payrollEnabled,
        ),
      ).toBe(true);
    });
  });

  describe('who may set a salary', () => {
    // A branch-scoped role only resolves its permissions when the request
    // names the branch: PermissionsGuard looks the grant up against the
    // `x-branch-id` header, and that same header is what pins
    // `branchScope` for the handler. See branch-scoping.e2e-spec.ts.
    const asBranchManager = (req: request.Test) =>
      authed(branchManagerToken)(req).set('x-branch-id', branchId);

    it('allows a branch manager, who holds hr.manage', async () => {
      // The reason these routes are gated on `hr.*` rather than
      // `users.update`: BRANCH_MANAGER runs HR for a branch and does not
      // hold `users.update` at all.
      await asBranchManager(
        request(app.getHttpServer())
          .patch(`/hr-payroll/staff/${staffUserId}`)
          .send({ baseSalary: 45000 }),
      ).expect(200);
    });

    it('confines a branch manager to their own branch', async () => {
      // Named branch is theirs, target staff member is not: the guard
      // lets them through and the handler's branchScope refuses, which is
      // the division of labour the guard's class comment describes.
      await asBranchManager(
        request(app.getHttpServer())
          .patch(`/hr-payroll/staff/${otherBranchUserId}`)
          .send({ baseSalary: 45000 }),
      ).expect(404);
    });

    it('will not let a branch manager claim another branch', async () => {
      await authed(branchManagerToken)(
        request(app.getHttpServer())
          .patch(`/hr-payroll/staff/${otherBranchUserId}`)
          .send({ baseSalary: 45000 })
          .set('x-branch-id', otherBranchId),
      ).expect(403);
    });

    it('denies an accountant, who holds neither hr permission', async () => {
      await authed(accountantToken)(
        request(app.getHttpServer())
          .patch(`/hr-payroll/staff/${staffUserId}`)
          .send({ baseSalary: 1 }),
      ).expect(403);

      await authed(accountantToken)(
        request(app.getHttpServer()).get('/hr-payroll/staff'),
      ).expect(403);
    });

    it('404s a user outside the organization', async () => {
      await setPayroll('00000000-0000-0000-0000-000000000000', {
        baseSalary: 1,
      }).expect(404);
    });
  });

  it('lets a payroll run be created entirely over HTTP', async () => {
    // The whole point of B-P1-7. Before it, this sequence was impossible
    // without opening a psql session: the run would 400 with "No
    // payroll-enabled staff found for this scope".
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);

    const run = await asOwner(
      request(app.getHttpServer()).post('/hr-payroll/payroll-runs').send({
        periodStart: start.toISOString(),
        periodEnd: end.toISOString(),
        branchId,
      }),
    ).expect(201);

    expect(run.body.data.status).toBe('DRAFT');

    const items = await prisma.payrollItem.findMany({
      where: { payrollRunId: run.body.data.id },
      select: { gross: true, staffProfileId: true },
    });
    expect(items.length).toBeGreaterThan(0);
    // And the payslips carry a real figure rather than the zero a null
    // salary would have produced.
    expect(items.some((i) => Number(i.gross) > 0)).toBe(true);
  });
});
