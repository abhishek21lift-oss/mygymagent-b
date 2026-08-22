import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ToolExecutorService } from '../src/ai/tools/tool-executor.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The Owner Daily Briefing (P3): a real, computed aggregation over the
 * same P1/P2 analytics services and the P3 Action Center backlog --
 * see src/briefing/daily-briefing.service.ts's class comment. What's
 * tested here is the aggregation reaching real data and the reports.view
 * gate, not the underlying computations themselves (already covered by
 * test/analytics-revenue.e2e-spec.ts, test/analytics-intelligence.e2e-spec.ts,
 * and test/ai-actions.e2e-spec.ts).
 */
describe('Owner Daily Briefing (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let toolExecutor: ToolExecutorService;
  let org: RegisteredAccount;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);

    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);

    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    toolExecutor = app.get(ToolExecutorService);
    org = await registerOrg('Daily Briefing Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('aggregates real today/this-month data: a check-in, a low-stock product, and a pending AI action', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Briefed',
        lastName: 'Member',
      }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/attendance/check-in').send({
        memberId: member.body.data.id,
        branchId: org.branchId,
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/products')
        .send({
          sku: `BRIEF-${Date.now()}`,
          name: 'Briefing Low Stock Item',
          unitPrice: 5,
          quantityOnHand: 1,
          reorderLevel: 5,
        }),
    ).expect(201);

    const exercise = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: 'Briefing Squat' }),
    ).expect(201);
    const workoutPlan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Briefing Plan',
          exercises: [
            {
              exerciseId: exercise.body.data.id,
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        }),
    ).expect(201);
    await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId: member.body.data.id, planId: workoutPlan.body.data.id },
      { organizationId: org.organizationId, userId: org.userId },
    );

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/briefing/daily'),
    ).expect(200);
    const briefing = res.body.data;

    expect(briefing.today.checkIns).toBeGreaterThanOrEqual(1);
    expect(briefing.revenue.period).toBeDefined();
    expect(Array.isArray(briefing.revenue.notComputable)).toBe(true);
    expect(briefing.lowStock.count).toBeGreaterThanOrEqual(1);
    expect(
      briefing.lowStock.top.some((p: { name: string }) =>
        p.name.startsWith('Briefing Low Stock Item'),
      ),
    ).toBe(true);
    expect(briefing.pendingAiActions).toBeGreaterThanOrEqual(1);
    expect(typeof briefing.atRiskMembers.count).toBe('number');
    expect(briefing.salesFunnel.period).toBeDefined();
    expect(typeof briefing.trainerWorkload.trainerCount).toBe('number');
    expect(
      briefing.trainerWorkload.notComputable.map((n: { key: string }) => n.key),
    ).toContain('ptSessionUtilization');
  });

  it('rejects a caller who holds ai.generate but not reports.view (TRAINER, per roles.catalog.ts)', async () => {
    const trainerEmail = `daily-briefing-trainer-${Date.now()}@example.com`;
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email: trainerEmail,
        firstName: 'No',
        lastName: 'Reports',
        primaryBranchId: org.branchId,
        roleKey: 'TRAINER',
      }),
    ).expect(201);
    const trainerId = invited.body.data.id;
    await prisma.user.update({
      where: { id: trainerId },
      data: { status: 'ACTIVE' },
    });

    await expect(
      toolExecutor.execute(
        'get_daily_briefing',
        {},
        { organizationId: org.organizationId, userId: trainerId },
      ),
    ).rejects.toThrow(/Missing permission/);
  });
});
