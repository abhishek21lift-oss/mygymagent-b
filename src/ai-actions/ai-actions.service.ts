import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AiActionType, Prisma } from '@prisma/client';
import { validateToolArgs } from '../ai/tools/validate-tool-args';
import { paginate, skipTake } from '../common/dto/pagination-query.dto';
import { DietPlansService } from '../nutrition/diet-plans.service';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsService } from '../rbac/permissions.service';
import { WorkoutPlansService } from '../workouts/workout-plans.service';
import { AssignPlanPayloadDto } from './dto/assign-plan-payload.dto';
import type { ListAiActionsQueryDto } from './dto/list-ai-actions-query.dto';

/** The REST-equivalent permission the *approver* must independently hold
 * for each action type -- "AI must never bypass existing permissions"
 * applies to the approval step too. `ai.approve` (checked by the
 * controller) means "can decide on AI proposals," not "can perform any
 * action an AI proposed" -- see AiActionsService.approve()'s comment. */
const REQUIRED_PERMISSION: Record<AiActionType, string> = {
  ASSIGN_WORKOUT_PLAN: 'workouts.assign',
  ASSIGN_DIET_PLAN: 'nutrition.assign',
};

/**
 * The Action Center: READ -> RECOMMEND -> DRAFT -> APPROVE -> EXECUTE for
 * AI-proposed changes the master prompt calls "high-risk" -- see the
 * `AiAction` model's schema comment for what distinguishes these from
 * P0-P2's AI tools, which never needed this (pure reads, or an inert
 * unassigned draft). This service owns propose/approve/reject/list; the
 * AI tools that call `propose*` live in `src/ai/tools/tool-executor.service.ts`.
 */
@Injectable()
export class AiActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionsService,
    private readonly workoutPlansService: WorkoutPlansService,
    private readonly dietPlansService: DietPlansService,
  ) {}

  async list(organizationId: string, query: ListAiActionsQueryDto) {
    const where = {
      organizationId,
      ...(query.status ? { status: query.status } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.aiAction.findMany({
        where,
        ...skipTake(query),
        orderBy: { createdAt: query.order ?? 'desc' },
        include: {
          proposedByUser: { select: { firstName: true, lastName: true } },
          decidedByUser: { select: { firstName: true, lastName: true } },
        },
      }),
      this.prisma.aiAction.count({ where }),
    ]);
    return paginate(items, total, query.page, query.pageSize);
  }

  async getOne(organizationId: string, id: string) {
    const action = await this.prisma.aiAction.findFirst({
      where: { id, organizationId },
    });
    if (!action) throw new NotFoundException('AI action not found');
    return action;
  }

  /** Used by the Owner Daily Briefing (`src/briefing/`) to surface "N
   * proposals awaiting your decision" -- a count, not the full list, so
   * the briefing doesn't duplicate what `GET /ai-actions` already shows
   * in detail. */
  async countPending(organizationId: string): Promise<number> {
    return this.prisma.aiAction.count({
      where: { organizationId, status: 'PENDING_APPROVAL' },
    });
  }

  /** Called by the `propose_assign_workout_plan`/`propose_assign_diet_plan`
   * AI tools -- confirms the member and plan are real before drafting a
   * proposal about them (a proposal for a nonexistent member helps no
   * one), and builds the human-readable `reasoning` an approver actually
   * needs, not just the raw payload. */
  async proposeAssignPlan(
    organizationId: string,
    proposedByUserId: string,
    type: 'ASSIGN_WORKOUT_PLAN' | 'ASSIGN_DIET_PLAN',
    payload: {
      memberId: string;
      planId: string;
      startDate?: string;
      notes?: string;
    },
  ) {
    const [member, plan] = await Promise.all([
      this.prisma.member.findFirst({
        where: { id: payload.memberId, organizationId, deletedAt: null },
        select: { firstName: true, lastName: true },
      }),
      type === 'ASSIGN_WORKOUT_PLAN'
        ? this.prisma.workoutPlan.findFirst({
            where: { id: payload.planId, organizationId },
            select: { name: true },
          })
        : this.prisma.dietPlan.findFirst({
            where: { id: payload.planId, organizationId },
            select: { name: true },
          }),
    ]);
    if (!member) throw new NotFoundException('Member not found');
    if (!plan) {
      throw new NotFoundException(
        type === 'ASSIGN_WORKOUT_PLAN'
          ? 'Workout plan not found'
          : 'Diet plan not found',
      );
    }

    const kind = type === 'ASSIGN_WORKOUT_PLAN' ? 'workout' : 'diet';
    return this.prisma.aiAction.create({
      data: {
        organizationId,
        type,
        status: 'PENDING_APPROVAL',
        payload,
        reasoning: `Assign ${kind} plan "${plan.name}" to ${member.firstName} ${member.lastName}`,
        proposedByUserId,
      },
    });
  }

  async approve(organizationId: string, id: string, decidedByUserId: string) {
    const action = await this.getOne(organizationId, id);
    if (action.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Cannot approve an action with status ${action.status}`,
      );
    }

    const requiredPermission = REQUIRED_PERMISSION[action.type];
    const allowed = await this.permissions.hasPermission(
      decidedByUserId,
      organizationId,
      requiredPermission,
    );
    if (!allowed) {
      throw new ForbiddenException(
        `Approving this action requires ${requiredPermission}`,
      );
    }

    await this.prisma.aiAction.update({
      where: { id },
      data: { status: 'APPROVED', decidedByUserId, decidedAt: new Date() },
    });

    try {
      const resultResourceId = await this.execute(
        organizationId,
        action,
        decidedByUserId,
      );
      return this.prisma.aiAction.update({
        where: { id },
        data: { status: 'EXECUTED', executedAt: new Date(), resultResourceId },
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return this.prisma.aiAction.update({
        where: { id },
        data: { status: 'FAILED', errorMessage },
      });
    }
  }

  async reject(
    organizationId: string,
    id: string,
    decidedByUserId: string,
    reason: string | undefined,
  ) {
    const action = await this.getOne(organizationId, id);
    if (action.status !== 'PENDING_APPROVAL') {
      throw new BadRequestException(
        `Cannot reject an action with status ${action.status}`,
      );
    }
    return this.prisma.aiAction.update({
      where: { id },
      data: {
        status: 'REJECTED',
        decidedByUserId,
        decidedAt: new Date(),
        rejectionReason: reason,
      },
    });
  }

  /** Re-validates the stored payload against the same DTO shape the
   * propose-tool used -- a payload drafted correctly weeks ago is still
   * re-checked now, the same "never trust stored JSON blindly" the rest
   * of this codebase applies to model-supplied input generally. The
   * *approving* user (not whoever proposed it) is recorded as the one
   * who performed the underlying action -- they're the real actor here;
   * the AI only drafted a suggestion. */
  private async execute(
    organizationId: string,
    action: { type: AiActionType; payload: any },
    decidedByUserId: string,
  ): Promise<string> {
    const payload = validateToolArgs(AssignPlanPayloadDto, action.payload);
    const dto = {
      memberId: payload.memberId,
      startDate: payload.startDate,
      notes: payload.notes,
    };
    switch (action.type) {
      case 'ASSIGN_WORKOUT_PLAN': {
        const assignment = await this.workoutPlansService.assign(
          organizationId,
          payload.planId,
          dto,
          decidedByUserId,
        );
        return assignment.id;
      }
      case 'ASSIGN_DIET_PLAN': {
        const assignment = await this.dietPlansService.assign(
          organizationId,
          payload.planId,
          dto,
          decidedByUserId,
        );
        return assignment.id;
      }
    }
  }

  /**
   * Execute an already approved action.
   * Used by the AI Supervisor when executing approved Action Center tools.
   */
  async executeApprovedAction(
    organizationId: string,
    id: string,
    approvalResult: any, // approval result from the approval step (not used)
    decidedByUserId: string, // the user who is requesting the execution (AI user or system)
  ): Promise<string> {
    const action = await this.getOne(organizationId, id);
    if (action.status !== 'APPROVED') {
      throw new BadRequestException(
        `Cannot execute an action with status ${action.status}`,
      );
    }
    // When an action is approved, the decidedByUserId is set to the approver.
    // We use that to execute the action (the approver is the one who performed the action).
    const executorUserId = action.decidedByUserId;
    if (!executorUserId) {
      // Fallback to the passed decidedByUserId if for some reason it's not set
      // (should not happen in normal flow)
      throw new BadRequestException(`Approved action missing decidedByUserId`);
    }
    return this.execute(organizationId, action, executorUserId);
  }
}
