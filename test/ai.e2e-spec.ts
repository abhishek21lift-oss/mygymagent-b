import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ToolExecutorService } from '../src/ai/tools/tool-executor.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * .env.test does not set OPENROUTER_API_KEY, so these tests can't exercise
 * a live model call -- that's covered by manual verification against a
 * real key. What's tested here without one: the module degrades to a
 * clear 503 rather than crashing, auth/permission enforcement holds, and
 * -- the most security-critical part of this module -- the tool executor
 * itself never leaks cross-tenant data or accepts malformed arguments,
 * independent of whatever the model says.
 */
describe('AI (e2e)', () => {
  let app: INestApplication;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;
  let toolExecutor: ToolExecutorService;
  let prisma: PrismaService;

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
    toolExecutor = app.get(ToolExecutorService);
    prisma = app.get(PrismaService);
    orgA = await registerOrg('AI Test Gym A');
    orgB = await registerOrg('AI Test Gym B');
  });

  afterAll(async () => {
    await app.close();
  });

  it('rejects unauthenticated requests', async () => {
    await request(app.getHttpServer())
      .post('/ai/chat')
      .send({ message: 'hi' })
      .expect(401);
  });

  it('returns 503 rather than crashing when OPENROUTER_API_KEY is unset', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/ai/chat').send({ message: 'hi' }),
    ).expect(503);
  });

  it('logs an AiUsageLog row with ERROR status when the provider call fails', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/ai/chat').send({ message: 'hi' }),
    ).expect(503);

    const rows = await prisma.aiUsageLog.findMany({
      where: { organizationId: orgA.organizationId, userId: orgA.userId },
      orderBy: { createdAt: 'desc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[0];
    expect(latest.status).toBe('ERROR');
    expect(latest.feature).toBe('chat');
    expect(latest.provider).toBe('openrouter');
    expect(latest.errorMessage).toContain('OPENROUTER_API_KEY');
    expect(latest.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("the read_member tool never returns another organization's member", async () => {
    const memberB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Secret',
        lastName: 'MemberB',
      }),
    ).expect(201);

    await expect(
      toolExecutor.execute(
        'read_member',
        { memberId: memberB.body.data.id },
        { organizationId: orgA.organizationId, userId: orgA.userId },
      ),
    ).rejects.toThrow('Member not found');
  });

  it('read_member returns a safe subset, not the raw row (no email/phone)', async () => {
    const member = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgA.branchId,
        firstName: 'Visible',
        lastName: 'Fields',
        email: 'visible.fields@example.com',
        phone: '+15550000000',
      }),
    ).expect(201);

    const result = (await toolExecutor.execute(
      'read_member',
      { memberId: member.body.data.id },
      { organizationId: orgA.organizationId, userId: orgA.userId },
    )) as Record<string, unknown>;

    expect(result.firstName).toBe('Visible');
    expect(result).not.toHaveProperty('email');
    expect(result).not.toHaveProperty('phone');
  });

  it('rejects a tool call missing required arguments', async () => {
    await expect(
      toolExecutor.execute(
        'read_member',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      ),
    ).rejects.toThrow(/Invalid tool arguments/);
  });

  it('rejects create_workout_draft referencing an exercise from another org', async () => {
    const exerciseB = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: 'Org B Only Exercise' }),
    ).expect(201);

    await expect(
      toolExecutor.execute(
        'create_workout_draft',
        {
          name: 'Cross-tenant draft',
          exercises: [
            {
              exerciseId: exerciseB.body.data.id,
              order: 1,
              sets: 3,
              reps: '10',
            },
          ],
        },
        { organizationId: orgA.organizationId, userId: orgA.userId },
      ),
    ).rejects.toThrow();
  });

  it("creates a diet draft scoped to the caller's org, rejecting a food item from another org", async () => {
    const foodA = await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/food-items')
        .send({ name: 'AI Test Chicken' }),
    ).expect(201);

    const result = (await toolExecutor.execute(
      'create_diet_draft',
      {
        name: 'AI Diet Draft',
        items: [
          {
            foodItemId: foodA.body.data.id,
            mealSlot: 'LUNCH',
            quantity: 200,
            unit: 'g',
          },
        ],
      },
      { organizationId: orgA.organizationId, userId: orgA.userId },
    )) as { id: string };
    expect(result.id).toBeDefined();

    const foodB = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/food-items')
        .send({ name: 'Org B Only Food' }),
    ).expect(201);

    await expect(
      toolExecutor.execute(
        'create_diet_draft',
        {
          name: 'Cross-tenant diet draft',
          items: [
            {
              foodItemId: foodB.body.data.id,
              mealSlot: 'LUNCH',
              quantity: 200,
              unit: 'g',
            },
          ],
        },
        { organizationId: orgA.organizationId, userId: orgA.userId },
      ),
    ).rejects.toThrow();
  });

  it("create_followup creates a real, auditable follow-up scoped to the caller's org", async () => {
    const lead = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Ai',
        lastName: 'Target',
      }),
    ).expect(201);

    const result = (await toolExecutor.execute(
      'create_followup',
      {
        leadId: lead.body.data.id,
        note: 'AI-suggested follow-up',
        dueAt: new Date(Date.now() + 86400000).toISOString(),
      },
      { organizationId: orgA.organizationId, userId: orgA.userId },
    )) as { id: string };
    expect(result.id).toBeDefined();

    const detail = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/leads/${lead.body.data.id}`),
    ).expect(200);
    expect(
      detail.body.data.followUps.some(
        (f: { id: string }) => f.id === result.id,
      ),
    ).toBe(true);
  });

  /**
   * Regression for the AI tool executor's RBAC bypass (audit finding
   * F-01): a TRAINER holds `members.read_assigned`, not the broader
   * `members.read` -- see member-assignment-scoping.e2e-spec.ts for the
   * same invariant proven over REST. Before the fix, `read_member` called
   * `MembersService.getOne(organizationId, memberId)` with no
   * branch/assignment scope at all, so a trainer could use the assistant
   * to look up any member in the org. These tests exercise the tool
   * executor directly with a real trainer's userId, exactly like the
   * cross-tenant tests above do for organizationId.
   */
  describe('tool executor enforces role/assignment scope, not just organizationId', () => {
    let trainerId: string;
    let assignedMemberId: string;
    let unassignedMemberId: string;

    beforeAll(async () => {
      const branches = await authed(orgA.accessToken)(
        request(app.getHttpServer()).get('/branches'),
      ).expect(200);
      const branchId = branches.body.data.items[0].id;

      const trainerEmail = `ai-scope-trainer-${Date.now()}@example.com`;
      const invited = await authed(orgA.accessToken)(
        request(app.getHttpServer()).post('/users').send({
          email: trainerEmail,
          firstName: 'AI',
          lastName: 'Trainer',
          primaryBranchId: branchId,
          roleKey: 'TRAINER',
        }),
      ).expect(201);
      trainerId = invited.body.data.id;
      await prisma.user.update({
        where: { id: trainerId },
        data: { status: 'ACTIVE' },
      });

      const assigned = await authed(orgA.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Assigned',
          lastName: 'ToAiTrainer',
          assignedTrainerId: trainerId,
        }),
      ).expect(201);
      assignedMemberId = assigned.body.data.id;

      const unassigned = await authed(orgA.accessToken)(
        request(app.getHttpServer()).post('/members').send({
          primaryBranchId: branchId,
          firstName: 'Not',
          lastName: 'AiTrainersClient',
        }),
      ).expect(201);
      unassignedMemberId = unassigned.body.data.id;
    });

    it('read_member lets a trainer look up their own assigned member', async () => {
      const result = (await toolExecutor.execute(
        'read_member',
        { memberId: assignedMemberId },
        { organizationId: orgA.organizationId, userId: trainerId },
      )) as Record<string, unknown>;
      expect(result.firstName).toBe('Assigned');
    });

    it('read_member no longer lets a trainer look up a member not assigned to them', async () => {
      await expect(
        toolExecutor.execute(
          'read_member',
          { memberId: unassignedMemberId },
          { organizationId: orgA.organizationId, userId: trainerId },
        ),
      ).rejects.toThrow('Member not found');
    });

    it('create_followup rejects a caller who holds ai.generate but not leads.manage', async () => {
      // TRAINER holds ai.generate (roles.catalog.ts) but not leads.manage --
      // before the fix, no tool checked any permission beyond ai.generate
      // at all, so this call would have succeeded.
      const lead = await authed(orgA.accessToken)(
        request(app.getHttpServer()).post('/leads').send({
          firstName: 'Should',
          lastName: 'BeUnreachable',
        }),
      ).expect(201);

      await expect(
        toolExecutor.execute(
          'create_followup',
          {
            leadId: lead.body.data.id,
            note: 'a trainer should not be able to create this',
            dueAt: new Date(Date.now() + 86400000).toISOString(),
          },
          { organizationId: orgA.organizationId, userId: trainerId },
        ),
      ).rejects.toThrow(/Missing permission/);
    });

    it('get_revenue_summary rejects a caller who holds ai.generate but not reports.view', async () => {
      // Same shape as the create_followup case above -- TRAINER holds
      // ai.generate but not reports.view (roles.catalog.ts).
      await expect(
        toolExecutor.execute(
          'get_revenue_summary',
          {},
          { organizationId: orgA.organizationId, userId: trainerId },
        ),
      ).rejects.toThrow(/Missing permission/);
    });
  });

  /**
   * P2 intelligence tools (src/analytics/) -- each mirrors a real
   * GET /analytics/* endpoint via the exact same service, so the
   * computation itself is already covered by
   * test/analytics-revenue.e2e-spec.ts and
   * test/analytics-intelligence.e2e-spec.ts. What's tested here is that
   * the tool executor actually reaches those services (permission-gated
   * on `reports.view`, matching the REST endpoints) and returns their
   * real shape, not a stub.
   */
  describe('P2 intelligence tools', () => {
    it('get_revenue_summary returns real revenue data and the notComputable disclosure', async () => {
      const result = (await toolExecutor.execute(
        'get_revenue_summary',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      )) as { revenue: unknown[]; notComputable: { key: string }[] };

      expect(Array.isArray(result.revenue)).toBe(true);
      expect(result.notComputable.map((n) => n.key)).toContain(
        'productRevenue',
      );
    });

    it('get_at_risk_members returns a real list (empty is valid, not an error)', async () => {
      const result = await toolExecutor.execute(
        'get_at_risk_members',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it('get_sales_funnel returns real funnel totals', async () => {
      const result = (await toolExecutor.execute(
        'get_sales_funnel',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      )) as { totalLeads: number };
      expect(typeof result.totalLeads).toBe('number');
    });

    it('get_trainer_workload returns the notComputable PT disclosure', async () => {
      const result = (await toolExecutor.execute(
        'get_trainer_workload',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      )) as { notComputable: { key: string }[] };
      expect(result.notComputable.map((n) => n.key)).toContain(
        'ptSessionUtilization',
      );
    });

    it('get_inventory_forecast returns a real list (empty is valid, not an error)', async () => {
      const result = await toolExecutor.execute(
        'get_inventory_forecast',
        {},
        { organizationId: orgA.organizationId, userId: orgA.userId },
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it('rejects unexpected arguments on a no-arg tool', async () => {
      await expect(
        toolExecutor.execute(
          'get_revenue_summary',
          { unexpected: 'field' },
          { organizationId: orgA.organizationId, userId: orgA.userId },
        ),
      ).rejects.toThrow(/Invalid tool arguments/);
    });
  });
});
