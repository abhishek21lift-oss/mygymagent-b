import { Injectable, NotFoundException } from '@nestjs/common';
import { AttendanceService } from '../../attendance/attendance.service';
import { AuditService } from '../../audit/audit.service';
import { LeadsService } from '../../crm/leads.service';
import { CreateDietPlanDto } from '../../nutrition/dto/create-diet-plan.dto';
import { DietPlansService } from '../../nutrition/diet-plans.service';
import { CreateWorkoutPlanDto } from '../../workouts/dto/create-workout-plan.dto';
import { MembersService } from '../../members/members.service';
import { WorkoutAssignmentsService } from '../../workouts/workout-assignments.service';
import { WorkoutPlansService } from '../../workouts/workout-plans.service';
import { CreateFollowupArgsDto } from './dto/create-followup-args.dto';
import { MemberIdArgsDto } from './dto/member-id-args.dto';
import type { AiToolName } from './tool-definitions';
import { validateToolArgs } from './validate-tool-args';

export interface ToolCallContext {
  organizationId: string;
  userId: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Executes one named tool call. Every branch below calls into the exact
 * same organizationId-scoped domain service the REST API uses -- there is
 * no separate "AI data access" path. `context.organizationId` always
 * comes from the authenticated caller's JWT (see AiService), never from
 * anything the model itself said, the same invariant every other service
 * in this codebase already enforces.
 */
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
  ) {}

  async execute(
    name: AiToolName,
    rawArgs: unknown,
    context: ToolCallContext,
  ): Promise<unknown> {
    switch (name) {
      case 'read_member':
        return this.readMember(rawArgs, context);
      case 'read_workout_history':
        return this.readWorkoutHistory(rawArgs, context);
      case 'read_attendance':
        return this.readAttendance(rawArgs, context);
      case 'create_workout_draft':
        return this.createWorkoutDraft(rawArgs, context);
      case 'create_diet_draft':
        return this.createDietDraft(rawArgs, context);
      case 'create_followup':
        return this.createFollowup(rawArgs, context);
      default: {
        const _exhaustive: never = name;
        throw new NotFoundException(`Unknown tool: ${String(_exhaustive)}`);
      }
    }
  }

  private async readMember(
    rawArgs: unknown,
    { organizationId }: ToolCallContext,
  ) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    const member = await this.membersService.getOne(organizationId, memberId);
    // Deliberately a narrow operational subset, not the raw row -- see
    // docs/database/data-ownership.md's AI-access column for Member.
    return {
      id: member.id,
      firstName: member.firstName,
      lastName: member.lastName,
      status: member.status,
      joinedAt: member.joinedAt,
      primaryBranch: member.primaryBranch?.name ?? null,
      assignedTrainer: member.assignedTrainer
        ? `${member.assignedTrainer.firstName} ${member.assignedTrainer.lastName}`
        : null,
      activeMemberships: member.memberships
        .filter((m) => m.status === 'ACTIVE')
        .map((m) => m.membershipPlan.name),
    };
  }

  private async readWorkoutHistory(
    rawArgs: unknown,
    { organizationId }: ToolCallContext,
  ) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    const assignments = await this.workoutAssignmentsService.list(
      organizationId,
      { page: 1, pageSize: 20 },
      memberId,
    );
    return assignments.items.map((a) => ({
      planName: a.workoutPlan.name,
      status: a.status,
      startDate: a.startDate,
    }));
  }

  private async readAttendance(
    rawArgs: unknown,
    { organizationId }: ToolCallContext,
  ) {
    const { memberId } = validateToolArgs(MemberIdArgsDto, rawArgs);
    // Summarized, not a raw dump -- see docs/database/data-ownership.md.
    // One page covers both the "5 most recent" and the 30-day count
    // (visit frequency rarely exceeds 50 in 30 days); a dedicated count
    // query is the natural upgrade once this tool sees real usage.
    const page = await this.attendanceService.list(
      organizationId,
      { page: 1, pageSize: 50, order: 'desc' },
      { memberId },
    );
    const thirtyDaysAgo = new Date(Date.now() - 30 * MS_PER_DAY);
    return {
      recentCheckIns: page.items.slice(0, 5).map((a) => a.checkInAt),
      approxVisitsLast30Days: page.items.filter(
        (a) => new Date(a.checkInAt) >= thirtyDaysAgo,
      ).length,
    };
  }

  private async createWorkoutDraft(
    rawArgs: unknown,
    { organizationId, userId }: ToolCallContext,
  ) {
    const dto = validateToolArgs(CreateWorkoutPlanDto, rawArgs);
    const plan = await this.workoutPlansService.create(
      organizationId,
      dto,
      userId,
    );
    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'ai_tool.create_workout_draft',
      resource: 'workout_plan',
      resourceId: plan.id,
      afterState: { name: plan.name, exerciseCount: dto.exercises.length },
    });
    return { id: plan.id, name: plan.name };
  }

  private async createDietDraft(
    rawArgs: unknown,
    { organizationId, userId }: ToolCallContext,
  ) {
    const dto = validateToolArgs(CreateDietPlanDto, rawArgs);
    const plan = await this.dietPlansService.create(
      organizationId,
      dto,
      userId,
    );
    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'ai_tool.create_diet_draft',
      resource: 'diet_plan',
      resourceId: plan.id,
      afterState: { name: plan.name, itemCount: dto.items.length },
    });
    return { id: plan.id, name: plan.name };
  }

  private async createFollowup(
    rawArgs: unknown,
    { organizationId, userId }: ToolCallContext,
  ) {
    const { leadId, note, dueAt } = validateToolArgs(
      CreateFollowupArgsDto,
      rawArgs,
    );
    const followUp = await this.leadsService.addFollowUp(
      organizationId,
      leadId,
      { note, dueAt },
      userId,
    );
    await this.audit.record({
      organizationId,
      actorUserId: userId,
      action: 'ai_tool.create_followup',
      resource: 'lead_follow_up',
      resourceId: followUp.id,
      afterState: { leadId, note, dueAt },
    });
    return { id: followUp.id, dueAt: followUp.dueAt };
  }
}
