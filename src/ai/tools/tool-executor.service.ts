import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiActionsService } from '../../ai-actions/ai-actions.service';
import { AssignPlanPayloadDto } from '../../ai-actions/dto/assign-plan-payload.dto';
import { FinanceService } from '../../analytics/finance.service';
import { DailyBriefingService } from '../../briefing/daily-briefing.service';
import { InventoryIntelligenceService } from '../../analytics/inventory-intelligence.service';
import { MemberIntelligenceService } from '../../analytics/member-intelligence.service';
import { SalesIntelligenceService } from '../../analytics/sales-intelligence.service';
import { TrainerIntelligenceService } from '../../analytics/trainer-intelligence.service';
import { AttendanceService } from '../../attendance/attendance.service';
import { AuditService } from '../../audit/audit.service';
import { LeadsService } from '../../crm/leads.service';
import { CreateDietPlanDto } from '../../nutrition/dto/create-diet-plan.dto';
import { DietPlansService } from '../../nutrition/diet-plans.service';
import { PermissionsService } from '../../rbac/permissions.service';
import { CreateWorkoutPlanDto } from '../../workouts/dto/create-workout-plan.dto';
import { MembersService } from '../../members/members.service';
import { WorkoutAssignmentsService } from '../../workouts/workout-assignments.service';
import { WorkoutPlansService } from '../../workouts/workout-plans.service';
import { CreateFollowupArgsDto } from './dto/create-followup-args.dto';
import { EmptyArgsDto } from './dto/empty-args.dto';
import { MemberIdArgsDto } from './dto/member-id-args.dto';
import type { AiToolName } from './tool-definitions';
import { validateToolArgs } from './validate-tool-args';

export interface ToolCallContext {
  organizationId: string;
  userId: string;
  requestedBranchId?: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export class ToolExecutorService {
  constructor(
    private readonly membersService: MembersService,
    private readonly attendanceService: AttendanceService,
    private readonly workoutPlansService: WorkoutPlansService,
    private readonly workoutAssignmentsService: WorkoutAssignmentsService,
    private readonly leadsService: LeadsService,
    private readonly dietPlansService: DietPlansService,
    private readonly audit: AuditService,
    private readonly permissions: PermissionsService,
    private readonly financeService: FinanceService,
    private readonly memberIntelligence: MemberIntelligenceService,
    private readonly salesIntelligence: SalesIntelligenceService,
    private readonly trainerIntelligence: TrainerIntelligenceService,
    private readonly inventoryIntelligence: InventoryIntelligenceService,
    private readonly aiActionsService: AiActionsService,
    private readonly dailyBriefingService: DailyBriefingService,
  ) {}

  private async resolveAccess(userId: string, organizationId: string, requestedBranchId: string | undefined, keys: readonly string[]) {
    for (const key of keys) {
      const allowed = await this.permissions.hasPermission(userId, organizationId, key, requestedBranchId);
      if (!allowed) continue;
      const orgWide = await this.permissions.hasPermission(userId, organizationId, key);
      return { branchScope: orgWide ? null : (requestedBranchId ?? null), matchedKey: key };
    }
    throw new ForbiddenException(`Missing permission: one of ${keys.join(', ')}`);
  }

  async execute(name: AiToolName, rawArgs: unknown, context: ToolCallContext): Promise<unknown> {
    switch (name) {
      case 'read_member': return this.readMember(rawArgs, context);
      case 'read_workout_history': return this.readWorkoutHistory(rawArgs, context);
      case 'read_attendance': return this.readAttendance(rawArgs, context);
      case 'create_workout_draft': return this.createWorkoutDraft(rawArgs, context);
      case 'create_diet_draft': return this.createDietDraft(rawArgs, context);
      case 'create_followup': return this.createFollowup(rawArgs, context);
      case 'get_revenue_summary': return this.getRevenueSummary(rawArgs, context);
      case 'get_at_risk_members': return this.getAtRiskMembers(rawArgs, context);
      case 'get_sales_funnel': return this.getSalesFunnel(rawArgs, context);
      case 'get_trainer_workload': return this.getTrainerWorkload(rawArgs, context);
      case 'get_inventory_forecast': return this.getInventoryForecast(rawArgs, context);
      case 'get_daily_briefing': return this.getDailyBriefing(rawArgs, context);
      case 'propose_assign_workout_plan': return this.proposeAssignWorkoutPlan(rawArgs, context);
      case 'propose_assign_diet_plan': return this.proposeAssignDietPlan(rawArgs, context);
      default: { const _exhaustive: never = name; throw new NotFoundException(`Unknown tool: ${String(_exhaustive)}`); }
    }
  }

  private async readMember(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    const { branchScope, matchedKey } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['members.read', 'members.read_assigned']);
    const member = await this.membersService.getOne(organizationId, memberId, branchScope, matchedKey === 'members.read_assigned' ? userId : null);
    return { id: member.id, firstName: member.firstName, lastName: member.lastName, status: member.status, joinedAt: member.joinedAt, primaryBranch: member.primaryBranch?.name ?? null, assignedTrainer: member.assignedTrainer ? `${member.assignedTrainer.firstName} ${member.assignedTrainer.lastName}` : null, activeMemberships: member.memberships.filter((m) => m.status === 'ACTIVE').map((m) => m.membershipPlan.name) };
  }

  private async readWorkoutHistory(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    const { branchScope, matchedKey } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['workouts.read', 'workouts.read_assigned']);
    const assignments = await this.workoutAssignmentsService.list(organizationId, { page: 1, pageSize: 20 }, memberId, branchScope, matchedKey === 'workouts.read_assigned' ? userId : null);
    return assignments.items.map((a) => ({ planName: a.workoutPlan.name, status: a.status, startDate: a.startDate }));
  }

  private async readAttendance(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['attendance.read']);
    const page = await this.attendanceService.list(organizationId, { page: 1, pageSize: 50, order: 'desc' }, { memberId, ...(branchScope ? { branchId: branchScope } : {}) });
    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
    return { recentCheckIns: page.items.slice(0, 5).map((a) => a.checkInAt), approxVisitsLast30Days: page.items.filter((a) => new Date(a.checkInAt) >= thirtyDaysAgo).length };
  }

  private async createWorkoutDraft(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    await this.resolveAccess(userId, organizationId, requestedBranchId, ['workouts.create']);
    const dto = validateToolArgs(CreateWorkoutPlanDto, rawArgs);
    const plan = await this.workoutPlansService.create(organizationId, dto, userId);
    await this.audit.record({ organizationId, actorUserId: userId, action: 'ai_tool.create_workout_draft', resource: 'workout_plan', resourceId: plan.id, afterState: { name: plan.name, exerciseCount: dto.exercises.length } });
    return { id: plan.id, name: plan.name };
  }

  private async createDietDraft(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    await this.resolveAccess(userId, organizationId, requestedBranchId, ['nutrition.create']);
    const dto = validateToolArgs(CreateDietPlanDto, rawArgs);
    const plan = await this.dietPlansService.create(organizationId, dto, userId);
    await this.audit.record({ organizationId, actorUserId: userId, action: 'ai_tool.create_diet_draft', resource: 'diet_plan', resourceId: plan.id, afterState: { name: plan.name, itemCount: dto.items.length } });
    return { id: plan.id, name: plan.name };
  }

  private async createFollowup(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    const { leadId, note, dueAt } = validateToolArgs(CreateFollowupArgsDto, rawArgs);
    const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['leads.manage']);
    const followUp = await this.leadsService.addFollowUp(organizationId, leadId, { note, dueAt }, userId, branchScope);
    await this.audit.record({ organizationId, actorUserId: userId, action: 'ai_tool.create_followup', resource: 'lead_follow_up', resourceId: followUp.id, afterState: { leadId, note, dueAt } });
    return { id: followUp.id, dueAt: followUp.dueAt };
  }

  private async getRevenueSummary(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.financeService.getRevenueSummary(organizationId, {}, branchScope);
  }
  private async getAtRiskMembers(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.memberIntelligence.getAtRiskMembers(organizationId, branchScope);
  }
  private async getSalesFunnel(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.salesIntelligence.getFunnel(organizationId, branchScope, {});
  }
  private async getTrainerWorkload(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.trainerIntelligence.getWorkload(organizationId, branchScope);
  }
  private async getInventoryForecast(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.inventoryIntelligence.getStockForecast(organizationId);
  }
  private async getDailyBriefing(rawArgs: unknown, { organizationId, userId, requestedBranchId }: ToolCallContext) {
    validateToolArgs(EmptyArgsDto, rawArgs); const { branchScope } = await this.resolveAccess(userId, organizationId, requestedBranchId, ['reports.view']); return this.dailyBriefingService.getBriefing(organizationId, branchScope);
  }
  private async proposeAssignWorkoutPlan(rawArgs: unknown, context: ToolCallContext) {
    await this.resolveAccess(context.userId, context.organizationId, context.requestedBranchId, ['workouts.assign']);
    const payload = validateToolArgs(AssignPlanPayloadDto, rawArgs);
    return this.aiActionsService.proposeAssignPlan(context.organizationId, context.userId, 'ASSIGN_WORKOUT_PLAN', payload);
  }
  private async proposeAssignDietPlan(rawArgs: unknown, context: ToolCallContext) {
    await this.resolveAccess(context.userId, context.organizationId, context.requestedBranchId, ['nutrition.assign']);
    const payload = validateToolArgs(AssignPlanPayloadDto, rawArgs);
    return this.aiActionsService.proposeAssignPlan(context.organizationId, context.userId, 'ASSIGN_DIET_PLAN', payload);
  }
}
