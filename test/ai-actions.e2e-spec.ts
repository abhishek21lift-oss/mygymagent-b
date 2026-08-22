import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AiActionsService } from '../src/ai-actions/ai-actions.service';
import { ToolExecutorService } from '../src/ai/tools/tool-executor.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The Action Center's full READ -> RECOMMEND -> DRAFT -> APPROVE -> EXECUTE
 * cycle, against real Postgres: an AI tool proposes a change, it has zero
 * effect until a human with the right permission approves it, and
 * approval alone (via `ai.approve`) is not enough -- the approver must
 * also independently hold the underlying resource permission, exactly
 * like every other AI-authorization invariant this project enforces.
 */
describe('AI Actions / Action Center (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let toolExecutor: ToolExecutorService;
  let org: RegisteredAccount;
  let memberId: string;
  let workoutPlanId: string;
  let dietPlanId: string;

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
    org = await registerOrg('Action Center Test Gym');

    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Programmed',
        lastName: 'Member',
      }),
    ).expect(201);
    memberId = member.body.data.id;

    const exercise = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/exercises')
        .send({ name: 'Action Center Squat' }),
    ).expect(201);
    const workoutPlan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/workout-plans')
        .send({
          name: 'Action Center Plan',
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
    workoutPlanId = workoutPlan.body.data.id;

    const foodItem = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/food-items')
        .send({ name: 'Action Center Chicken' }),
    ).expect(201);
    const dietPlan = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/diet-plans')
        .send({
          name: 'Action Center Diet',
          items: [
            {
              foodItemId: foodItem.body.data.id,
              mealSlot: 'LUNCH',
              quantity: 200,
              unit: 'g',
            },
          ],
        }),
    ).expect(201);
    dietPlanId = dietPlan.body.data.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('propose_assign_workout_plan drafts a proposal with zero real effect until approved', async () => {
    const result = (await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { actionId: string; status: string; reasoning: string };

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.reasoning).toContain('Action Center Plan');

    const assignments = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workout-assignments')
        .query({ memberId }),
    ).expect(200);
    expect(assignments.body.data.items).toHaveLength(0);

    const approved = await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/ai-actions/${result.actionId}/approve`,
      ),
    ).expect(200);
    expect(approved.body.data.status).toBe('EXECUTED');
    expect(approved.body.data.resultResourceId).toBeTruthy();

    const afterApproval = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workout-assignments')
        .query({ memberId }),
    ).expect(200);
    expect(afterApproval.body.data.items).toHaveLength(1);
    expect(afterApproval.body.data.items[0].id).toBe(
      approved.body.data.resultResourceId,
    );
  });

  it('rejecting a proposal leaves no diet assignment behind', async () => {
    const result = (await toolExecutor.execute(
      'propose_assign_diet_plan',
      { memberId, planId: dietPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { actionId: string; status: string };
    expect(result.status).toBe('PENDING_APPROVAL');

    const rejected = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/ai-actions/${result.actionId}/reject`)
        .send({ reason: 'Not the right plan for this member' }),
    ).expect(200);
    expect(rejected.body.data.status).toBe('REJECTED');
    expect(rejected.body.data.rejectionReason).toBe(
      'Not the right plan for this member',
    );

    const assignments = await prisma.dietAssignment.findMany({
      where: { organizationId: org.organizationId, memberId },
    });
    expect(assignments).toHaveLength(0);
  });

  it('cannot approve or reject an action that has already been decided', async () => {
    const result = (await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { actionId: string };

    await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/ai-actions/${result.actionId}/approve`,
      ),
    ).expect(200);

    await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/ai-actions/${result.actionId}/approve`,
      ),
    ).expect(400);
    await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/ai-actions/${result.actionId}/reject`,
      ),
    ).expect(400);
  });

  it('rejects proposing without the underlying resource permission (workouts.assign)', async () => {
    const accountantEmail = `action-center-accountant-${Date.now()}@example.com`;
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email: accountantEmail,
        firstName: 'No',
        lastName: 'Assign',
        primaryBranchId: org.branchId,
        roleKey: 'ACCOUNTANT',
      }),
    ).expect(201);
    const accountantId = invited.body.data.id;
    await prisma.user.update({
      where: { id: accountantId },
      data: { status: 'ACTIVE' },
    });

    // ACCOUNTANT holds payments-related permissions but not
    // workouts.assign (roles.catalog.ts).
    await expect(
      toolExecutor.execute(
        'propose_assign_workout_plan',
        { memberId, planId: workoutPlanId },
        { organizationId: org.organizationId, userId: accountantId },
      ),
    ).rejects.toThrow(/Missing permission/);
  });

  it("approving requires the approver's own resource permission, not just ai.approve", async () => {
    const result = (await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { actionId: string };

    // An ACCOUNTANT who's been granted ai.approve directly (an override,
    // not via role -- ACCOUNTANT doesn't have it by default) but still
    // has no workouts.assign grant of their own.
    const accountantEmail = `action-center-approver-${Date.now()}@example.com`;
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email: accountantEmail,
        firstName: 'Cant',
        lastName: 'ReallyApprove',
        primaryBranchId: org.branchId,
        roleKey: 'ACCOUNTANT',
      }),
    ).expect(201);
    const restrictedApproverId = invited.body.data.id;
    await prisma.user.update({
      where: { id: restrictedApproverId },
      data: { status: 'ACTIVE' },
    });
    const approvePermission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'ai.approve' },
    });
    await prisma.userPermissionOverride.create({
      data: {
        userId: restrictedApproverId,
        permissionId: approvePermission.id,
        organizationId: org.organizationId,
        branchId: null,
        effect: 'ALLOW',
      },
    });

    // The REST route itself would already reject this caller at the
    // ai.approve guard if the override above weren't in place; calling
    // the service directly here isolates the specific invariant this
    // test is about -- ai.approve passing is not sufficient on its own.
    const aiActionsService = app.get(AiActionsService);
    await expect(
      aiActionsService.approve(
        org.organizationId,
        result.actionId,
        restrictedApproverId,
      ),
    ).rejects.toThrow(/requires workouts.assign/);

    const stillPending = await aiActionsService.getOne(
      org.organizationId,
      result.actionId,
    );
    expect(stillPending.status).toBe('PENDING_APPROVAL');
  });
});
