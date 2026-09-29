import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AiActionsService } from '../src/ai-actions/ai-actions.service';
import { AiSupervisorService } from '../src/ai/supervisor/ai-supervisor.service';
import { TokensService } from '../src/auth/tokens.service';
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
  let tokens: TokensService;
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
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    toolExecutor = app.get(ToolExecutorService);
    tokens = app.get(TokensService);
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

  /**
   * A second ACTIVE user in the same organization, for tests where the
   * proposer must not be the approver.
   *
   * ORG_OWNER holds every permission by definition (`ALL_PERMISSIONS`),
   * so this second account is given the same role rather than a narrow
   * grant — the point of the separation-of-duties tests is *who* decides,
   * not what they are allowed to decide.
   */
  async function secondUser(): Promise<RegisteredAccount> {
    const email = `action-center-second-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email,
        firstName: 'Second',
        lastName: 'Approver',
        primaryBranchId: org.branchId,
        roleKey: 'ORG_OWNER',
      }),
    ).expect(201);
    const id = invited.body.data.id;
    await prisma.user.update({
      where: { id },
      data: { status: 'ACTIVE' },
    });
    // A token signed directly rather than via /auth/login. An invited
    // account has no password until it accepts its invitation, so a
    // password login here would 401 -- and walking the invite-accept flow
    // is covered by the auth suite, not this one. Same approach as
    // branch-scoping.e2e-spec.ts's manager fixture.
    return {
      accessToken: tokens.signAccessToken(id),
      organizationId: org.organizationId,
      userId: id,
      branchId: org.branchId,
    };
  }

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('propose_assign_workout_plan drafts a proposal with zero real effect until approved', async () => {
    const result = (await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { id: string; status: string; reasoning: string };

    expect(result.status).toBe('PENDING_APPROVAL');
    expect(result.reasoning).toContain('Action Center Plan');

    const assignments = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/workout-assignments')
        .query({ memberId }),
    ).expect(200);
    expect(assignments.body.data.items).toHaveLength(0);

    // A different person with the same permission decides it. The owner
    // proposed it, so under separation of duties the owner may not also
    // approve it -- see the dedicated case below.
    const approver = await secondUser();
    const approved = await authed(approver.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/approve`),
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
    )) as { id: string; status: string };
    expect(result.status).toBe('PENDING_APPROVAL');

    // Rejecting your own proposal is fine -- declining your own idea needs
    // no second opinion, and the restriction is deliberately one-sided.
    const rejected = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/ai-actions/${result.id}/reject`)
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
    )) as { id: string };

    const approver = await secondUser();
    await authed(approver.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/approve`),
    ).expect(200);

    // Already EXECUTED, so neither verb is available to anyone -- the
    // second user here is only proving the state check, not the
    // separation of duties.
    await authed(approver.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/approve`),
    ).expect(400);
    await authed(approver.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/reject`),
    ).expect(400);
  });

  it('refuses to let the proposer approve their own proposal', async () => {
    // The defect this pins: `SupervisorService.executeWithApproval` used
    // to take an approver and call `approve()` itself, and the only caller
    // passed the *requesting* user. So the AI command shell proposed a
    // plan and executed it in one request, and the permission check in
    // `approve` only confirmed the asker could have done it anyway. The
    // approval step had no content.
    //
    // The proposer here is an ORG_OWNER, who holds `workouts.assign` by
    // definition — so before the fix this call returned 200 and a workout
    // plan landed on a real member.
    const before = await prisma.workoutAssignment.count({
      where: { organizationId: org.organizationId, memberId },
    });

    const result = (await toolExecutor.execute(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { id: string };

    await authed(org.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/approve`),
    ).expect(403);

    // And nothing was executed: the action is still awaiting a decision,
    // and no new assignment appeared. The count is a delta rather than a
    // total because the shared `memberId` already carries an assignment
    // from the first case in this suite.
    const stillPending = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/ai-actions/${result.id}`),
    ).expect(200);
    expect(stillPending.body.data.status).toBe('PENDING_APPROVAL');
    expect(stillPending.body.data.decidedByUserId).toBeNull();

    const after = await prisma.workoutAssignment.count({
      where: { organizationId: org.organizationId, memberId },
    });
    expect(after).toBe(before);

    // A different person with the same permission can still do it, which
    // is what makes this separation of duties and not a dead end.
    const approver = await secondUser();
    const approved = await authed(approver.accessToken)(
      request(app.getHttpServer()).patch(`/ai-actions/${result.id}/approve`),
    ).expect(200);
    expect(approved.body.data.status).toBe('EXECUTED');
  });

  it('the supervisor proposes without approving', async () => {
    // `executeWithApproval` is where the self-approval lived, so that is
    // what this drives. It cannot be reached through `processCommand`:
    // `parseCommand` returns `isActionable: false` from all seven of its
    // branches, so the actionable path there is currently unreachable and
    // an unrecognised command falls through to the LLM chat handler.
    // That is pre-existing behaviour and not what this change is about.
    //
    // What is under test is the guarantee: calling this proposes and
    // stops. Before the fix it took an approver and approved, and the one
    // caller passed the requester.
    const supervisor = app.get(AiSupervisorService);
    const before = await prisma.workoutAssignment.count({
      where: { organizationId: org.organizationId, memberId },
    });

    const proposal = (await supervisor.executeWithApproval(
      'propose_assign_workout_plan',
      { memberId, planId: workoutPlanId },
      { organizationId: org.organizationId, userId: org.userId },
    )) as { id: string; status: string; decidedByUserId: string | null };

    // Proposed, not executed, and nobody has decided it.
    expect(proposal.status).toBe('PENDING_APPROVAL');
    expect(proposal.decidedByUserId).toBeNull();

    const row = await prisma.aiAction.findUniqueOrThrow({
      where: { id: proposal.id },
    });
    expect(row.status).toBe('PENDING_APPROVAL');
    expect(row.decidedByUserId).toBeNull();
    expect(row.executedAt).toBeNull();

    // And the member's plan is untouched.
    const after = await prisma.workoutAssignment.count({
      where: { organizationId: org.organizationId, memberId },
    });
    expect(after).toBe(before);

    // No action anywhere was decided by the person who asked for it.
    const selfDecided = await prisma.aiAction.findMany({
      where: {
        organizationId: org.organizationId,
        decidedByUserId: org.userId,
        status: { in: ['APPROVED', 'EXECUTED'] },
      },
    });
    expect(selfDecided).toHaveLength(0);
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
    )) as { id: string };

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
        result.id,
        restrictedApproverId,
      ),
    ).rejects.toThrow(/requires workouts.assign/);

    const stillPending = await aiActionsService.getOne(
      org.organizationId,
      result.id,
    );
    expect(stillPending.status).toBe('PENDING_APPROVAL');
  });
});
