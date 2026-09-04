import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DomainEvent } from '../events/domain-events';
import type { PrismaService } from '../prisma/prisma.service';
import { WorkoutSessionsService } from './workout-sessions.service';

const ORG = 'org-1';
const TRAINER = 'trainer-user-1';

function makePrisma() {
  const create = jest.fn();
  const findMany = jest.fn();
  const findFirst = jest.fn();
  const update = jest.fn();
  const upsert = jest.fn();

  const prisma = {
    workoutAssignment: { findFirst },
    workoutSession: { findFirst, findMany, create, update },
    workoutSessionSet: { upsert },
    exercise: { findMany },
    member: { findFirst },
  };
  return {
    prisma: prisma as unknown as PrismaService,
    create,
    findMany,
    findFirst,
    update,
    upsert,
    exerciseFindMany: prisma.exercise.findMany,
    memberFindFirst: prisma.member.findFirst,
  };
}

const emit = jest.fn();

function makeService() {
  const m = makePrisma();
  const service = new WorkoutSessionsService(m.prisma, {
    emit,
  } as never);
  return { service, m };
}

/** A session row as Prisma would return it with the service's includes. */
function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'session-1',
    assignmentId: 'assignment-1',
    memberId: 'member-1',
    branchId: 'branch-1',
    sessionDate: new Date('2026-09-03T10:00:00Z'),
    status: 'IN_PROGRESS',
    startedAt: new Date('2026-09-03T10:00:00Z'),
    completedAt: null,
    notes: null,
    exercises: [
      {
        id: 'snap-1',
        exerciseId: 'exercise-1',
        name: 'Back Squat',
        setsTarget: 3,
        repsTarget: '8-12',
        restSeconds: 90,
        displayOrder: 1,
        notes: null,
      },
    ],
    member: { id: 'member-1', firstName: 'Alex', lastName: 'Adams' },
    assignment: { workoutPlan: { name: 'Full Body Foundation' } },
    sets: [],
    ...overrides,
  };
}

describe('WorkoutSessionsService', () => {
  beforeEach(() => {
    emit.mockClear();
  });

  describe('start', () => {
    it('snapshots the plan into the session and emits the started event', async () => {
      const { service, m } = makeService();
      m.findFirst
        .mockResolvedValueOnce({
          id: 'assignment-1',
          memberId: 'member-1',
          status: 'ACTIVE',
          workoutPlan: {
            exercises: [
              {
                exerciseId: 'exercise-1',
                order: 1,
                sets: 3,
                reps: '8-12',
                restSeconds: 90,
              },
            ],
          },
        })
        // member lookup inside resolveMemberBranch
        .mockResolvedValueOnce({ primaryBranchId: 'branch-1' })
        // getOne's session lookup
        .mockResolvedValueOnce(sessionRow());
      m.exerciseFindMany.mockResolvedValue([
        { id: 'exercise-1', name: 'Back Squat' },
      ]);
      m.create.mockResolvedValue({
        id: 'session-1',
        assignmentId: 'assignment-1',
        memberId: 'member-1',
        branchId: 'branch-1',
      });

      const result = await service.start(ORG, 'assignment-1', TRAINER, null);

      // The snapshot is written with library-resolved names and stable ids.
      const data = m.create.mock.calls[0][0].data;
      expect(data.organizationId).toBe(ORG);
      expect(data.branchId).toBe('branch-1');
      expect(data.createdByUserId).toBe(TRAINER);
      expect(data.exercises).toHaveLength(1);
      expect(data.exercises[0]).toMatchObject({
        exerciseId: 'exercise-1',
        name: 'Back Squat',
        setsTarget: 3,
        repsTarget: '8-12',
        restSeconds: 90,
        displayOrder: 1,
      });
      expect(data.exercises[0].id).toBeTruthy();

      expect(emit).toHaveBeenCalledWith(DomainEvent.WorkoutSessionStarted, {
        organizationId: ORG,
        branchId: 'branch-1',
        workoutSessionId: 'session-1',
        workoutAssignmentId: 'assignment-1',
        memberId: 'member-1',
        startedByUserId: TRAINER,
      });
      expect(result.firstName).toBe('Alex');
      expect(result.workoutPlanName).toBe('Full Body Foundation');
    });

    it('rejects a non-ACTIVE assignment without creating anything', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce({
        id: 'assignment-1',
        memberId: 'member-1',
        status: 'COMPLETED',
        workoutPlan: { exercises: [] },
      });

      await expect(
        service.start(ORG, 'assignment-1', TRAINER, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.create).not.toHaveBeenCalled();
    });

    it('falls back to a stored plan name when the library entry is gone', async () => {
      const { service, m } = makeService();
      m.findFirst
        .mockResolvedValueOnce({
          id: 'assignment-1',
          memberId: 'member-1',
          status: 'ACTIVE',
          workoutPlan: {
            exercises: [
              {
                exerciseId: 'exercise-1',
                order: 1,
                sets: 3,
                reps: '8-12',
                name: 'Squat Variant',
              },
            ],
          },
        })
        .mockResolvedValueOnce({ primaryBranchId: 'branch-1' })
        .mockResolvedValueOnce(sessionRow());
      m.exerciseFindMany.mockResolvedValue([]);
      m.create.mockResolvedValue({
        id: 'session-1',
        branchId: 'branch-1',
        assignmentId: 'assignment-1',
        memberId: 'member-1',
      });

      await service.start(ORG, 'assignment-1', TRAINER, null);
      expect(m.create.mock.calls[0][0].data.exercises[0].name).toBe(
        'Squat Variant',
      );
    });
  });

  describe('logSet', () => {
    it('upserts the set against the compound unique key', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(sessionRow());
      m.upsert.mockResolvedValue({ id: 'set-1' });
      m.findFirst.mockResolvedValueOnce(sessionRow());

      await service.logSet(
        ORG,
        'session-1',
        'snap-1',
        {
          setNumber: 2,
          weightKg: 60,
          reps: 10,
          rpe: 7,
        } as never,
        null,
      );

      expect(m.upsert).toHaveBeenCalledWith({
        where: {
          sessionId_exerciseId_setNumber: {
            sessionId: 'session-1',
            exerciseId: 'snap-1',
            setNumber: 2,
          },
        },
        create: {
          organizationId: ORG,
          sessionId: 'session-1',
          exerciseId: 'snap-1',
          setNumber: 2,
          weightKg: 60,
          reps: 10,
          rpe: 7,
          notes: undefined,
        },
        update: { weightKg: 60, reps: 10, rpe: 7, notes: undefined },
      });
    });

    it('rejects a completed session', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      await expect(
        service.logSet(
          ORG,
          'session-1',
          'snap-1',
          {
            setNumber: 1,
            reps: 5,
          } as never,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.upsert).not.toHaveBeenCalled();
    });

    it('rejects an exercise id outside the session snapshot', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(sessionRow());
      await expect(
        service.logSet(
          ORG,
          'session-1',
          '00000000-0000-0000-0000-000000000000',
          {
            setNumber: 1,
            reps: 5,
          } as never,
          null,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.upsert).not.toHaveBeenCalled();
    });
  });

  describe('complete', () => {
    it('marks the session completed, stamps completedAt and emits the event', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(sessionRow()).mockResolvedValueOnce(
        sessionRow({
          status: 'COMPLETED',
          completedAt: new Date('2026-09-03T10:45:00Z'),
        }),
      );
      m.update.mockResolvedValue({
        id: 'session-1',
        status: 'COMPLETED',
        completedAt: new Date('2026-09-03T10:45:00Z'),
        assignmentId: 'assignment-1',
        memberId: 'member-1',
        branchId: 'branch-1',
      });

      const result = await service.complete(ORG, 'session-1', TRAINER, null);

      expect(m.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'session-1' },
          data: expect.objectContaining({ status: 'COMPLETED' }),
        }),
      );
      expect(emit).toHaveBeenCalledWith(DomainEvent.WorkoutSessionCompleted, {
        organizationId: ORG,
        branchId: 'branch-1',
        workoutSessionId: 'session-1',
        workoutAssignmentId: 'assignment-1',
        memberId: 'member-1',
        completedByUserId: TRAINER,
        completedAt: expect.any(Date),
      });
      expect(result.status).toBe('COMPLETED');
    });

    it('rejects completing an already-completed session', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(
        sessionRow({ status: 'COMPLETED', completedAt: new Date() }),
      );
      await expect(
        service.complete(ORG, 'session-1', TRAINER, null),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(m.update).not.toHaveBeenCalled();
    });
  });

  describe('tenant and assignment scoping', () => {
    it('scopes session lookups to the organization always', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(null);
      await expect(
        service.getOne('other-org', 'session-1', null),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('folds an assignment scope into reads for getOne and listToday', async () => {
      const { service, m } = makeService();
      m.findFirst.mockResolvedValueOnce(null);
      await service.getOne(ORG, 'session-1', TRAINER).catch(() => undefined);
      expect(m.findFirst.mock.calls[0][0].where).toMatchObject({
        id: 'session-1',
        organizationId: ORG,
        member: { assignedTrainerId: TRAINER },
      });

      m.findMany.mockResolvedValue([]);
      await service.listToday(ORG, TRAINER);
      expect(m.findMany.mock.calls[0][0].where).toMatchObject({
        organizationId: ORG,
        member: { assignedTrainerId: TRAINER },
      });

      m.findMany.mockClear();
      await service.listToday(ORG, null);
      expect(m.findMany.mock.calls[0][0].where.member).toBeUndefined();
    });
  });
});
