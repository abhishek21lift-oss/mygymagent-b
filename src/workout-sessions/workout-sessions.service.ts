import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import { DomainEvent, type WorkoutSessionCompletedEvent, type WorkoutSessionStartedEvent } from '../events/domain-events';
import { PrismaService } from '../prisma/prisma.service';
import type { LogWorkoutSetDto } from './dto/log-workout-set.dto';

@Injectable()
export class WorkoutSessionsService {
  constructor(private readonly prisma: PrismaService, private readonly events: EventEmitter2) {}

  async listToday(organizationId: string, assignmentScope: string | null) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const sessions = await this.prisma.workoutSession.findMany({
      where: { id: { not: undefined }, organizationId, sessionDate: { gte: startOfDay, lt: endOfDay }, ...(assignmentScope ? { member: { assignedTrainerId: assignmentScope } } : {}) },
      orderBy: { startedAt: 'desc' },
      include: { member: { select: { id: true, firstName: true, lastName: true } }, assignment: { select: { workoutPlan: { select: { name: true } } } } },
    });
    return sessions.map((session) => ({
      id: session.id, assignmentId: session.assignmentId, memberId: session.memberId, branchId: session.branchId,
      sessionDate: session.sessionDate, status: session.status, startedAt: session.startedAt, completedAt: session.completedAt,
      notes: session.notes, firstName: session.member.firstName, lastName: session.member.lastName,
      workoutPlanName: session.assignment.workoutPlan.name,
    }));
  }

  async getOne(organizationId: string, id: string, assignmentScope: string | null) {
    const session = await this.prisma.workoutSession.findFirst({
      where: { id, organizationId, ...(assignmentScope ? { member: { assignedTrainerId: assignmentScope } } : {}) },
      include: {
        member: { select: { id: true, firstName: true, lastName: true } },
        assignment: { select: { workoutPlan: { select: { name: true } } } },
        sets: { orderBy: { setNumber: 'asc' } },
      },
    });
    if (!session) throw new NotFoundException('Workout session not found');
    return this.toSessionResponse(session);
  }

  async start(organizationId: string, assignmentId: string, startedByUserId: string, assignmentScope: string | null) {
    const assignment = await this.prisma.workoutAssignment.findFirst({
      where: { id: assignmentId, organizationId, ...(assignmentScope ? { member: { assignedTrainerId: assignmentScope } } : {}) },
      include: { member: { select: { id: true, primaryBranchId: true } }, workoutPlan: true },
    });
    if (!assignment) throw new NotFoundException('Workout assignment not found');
    if (assignment.status !== 'ACTIVE') throw new BadRequestException('Only an active assignment can start a workout session');

    const planExercises = Array.isArray(assignment.workoutPlan.exercises) ? assignment.workoutPlan.exercises as Array<Record<string, unknown>> : [];
    const referencedIds = planExercises.filter((entry) => typeof entry.exerciseId === 'string').map((entry) => entry.exerciseId as string);
    const libraryExercises = await this.prisma.exercise.findMany({ where: { organizationId, id: { in: referencedIds } }, select: { id: true, name: true } });
    const nameById = new Map(libraryExercises.map((exercise) => [exercise.id, exercise.name]));
    const snapshot = planExercises.map((entry, index) => ({
      id: randomUUID(), exerciseId: typeof entry.exerciseId === 'string' ? entry.exerciseId : null,
      name: (typeof entry.exerciseId === 'string' && nameById.get(entry.exerciseId)) || (typeof entry.name === 'string' ? entry.name : 'Exercise'),
      setsTarget: typeof entry.sets === 'number' ? entry.sets : null,
      repsTarget: typeof entry.reps === 'string' || typeof entry.reps === 'number' ? String(entry.reps) : null,
      restSeconds: typeof entry.restSeconds === 'number' ? entry.restSeconds : null,
      displayOrder: typeof entry.order === 'number' ? entry.order : index + 1,
      notes: typeof entry.notes === 'string' ? entry.notes : null,
    }));

    const session = await this.prisma.workoutSession.create({
      data: { organizationId, assignmentId: assignment.id, memberId: assignment.memberId, branchId: assignment.member.primaryBranchId, exercises: snapshot, createdByUserId: startedByUserId },
    });
    const event: WorkoutSessionStartedEvent = {
      organizationId, branchId: session.branchId, workoutSessionId: session.id, workoutAssignmentId: assignment.id,
      memberId: assignment.memberId, startedByUserId,
    };
    this.events.emit(DomainEvent.WorkoutSessionStarted, event);
    return this.getOne(organizationId, session.id, assignmentScope);
  }

  async logSet(organizationId: string, sessionId: string, sessionExerciseId: string, dto: LogWorkoutSetDto, assignmentScope: string | null) {
    const session = await this.prisma.workoutSession.findFirst({ where: { id: sessionId, organizationId, ...(assignmentScope ? { member: { assignedTrainerId: assignmentScope } } : {}) } });
    if (!session) throw new NotFoundException('Workout session not found');
    if (session.status !== 'IN_PROGRESS') throw new BadRequestException('Cannot log sets to a completed workout session');
    const exercises = Array.isArray(session.exercises) ? session.exercises as Array<{ id?: unknown }> : [];
    if (!exercises.some((entry) => entry.id === sessionExerciseId)) throw new BadRequestException('Exercise is not part of this workout session');
    await this.prisma.workoutSessionSet.upsert({
      where: { sessionId_exerciseId_setNumber: { sessionId, exerciseId: sessionExerciseId, setNumber: dto.setNumber } },
      create: { organizationId, sessionId, exerciseId: sessionExerciseId, setNumber: dto.setNumber, weightKg: dto.weightKg, reps: dto.reps, rpe: dto.rpe, notes: dto.notes },
      update: { weightKg: dto.weightKg, reps: dto.reps, rpe: dto.rpe, notes: dto.notes },
    });
    return this.getOne(organizationId, sessionId, assignmentScope);
  }

  async complete(organizationId: string, id: string, completedByUserId: string, assignmentScope: string | null) {
    const session = await this.prisma.workoutSession.findFirst({ where: { id, organizationId, ...(assignmentScope ? { member: { assignedTrainerId: assignmentScope } } : {}) } });
    if (!session) throw new NotFoundException('Workout session not found');
    if (session.status === 'COMPLETED') throw new BadRequestException('Workout session is already completed');
    const completedAt = new Date();
    const updated = await this.prisma.workoutSession.update({ where: { id }, data: { status: 'COMPLETED', completedAt } });
    const event: WorkoutSessionCompletedEvent = {
      organizationId, branchId: updated.branchId, workoutSessionId: updated.id, workoutAssignmentId: updated.assignmentId,
      memberId: updated.memberId, completedByUserId, completedAt,
    };
    this.events.emit(DomainEvent.WorkoutSessionCompleted, event);
    return this.getOne(organizationId, id, assignmentScope);
  }

  private toSessionResponse(session: any) {
    const exercises = (Array.isArray(session.exercises) ? session.exercises : []).map((entry: any) => ({
      id: entry.id, exerciseId: entry.exerciseId ?? null, exerciseName: entry.name ?? 'Exercise',
      setsTarget: entry.setsTarget ?? null, repsTarget: entry.repsTarget ?? null, restSeconds: entry.restSeconds ?? null,
      displayOrder: entry.displayOrder ?? 0, notes: entry.notes ?? null,
    }));
    return {
      id: session.id, assignmentId: session.assignmentId, memberId: session.memberId, branchId: session.branchId,
      sessionDate: session.sessionDate, status: session.status, startedAt: session.startedAt, completedAt: session.completedAt,
      notes: session.notes, firstName: session.member.firstName, lastName: session.member.lastName,
      workoutPlanName: session.assignment.workoutPlan.name, exercises,
      sets: session.sets.map((set: any) => ({ id: set.id, sessionExerciseId: set.exerciseId, setNumber: set.setNumber, weightKg: set.weightKg, reps: set.reps, rpe: set.rpe, notes: set.notes, completedAt: set.completedAt })),
    };
  }
}
