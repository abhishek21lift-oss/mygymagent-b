import 'reflect-metadata';
import { ToolExecutorService } from './tool-executor.service';

function executor(deps: Record<string, unknown>) {
  const none = {};
  return new ToolExecutorService(
    (deps.membersService ?? none) as never,
    none as never,
    none as never,
    (deps.workoutAssignmentsService ?? none) as never,
    none as never,
    none as never,
    none as never,
    (deps.permissions ?? none) as never,
    none as never,
    (deps.memberIntelligence ?? none) as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    none as never,
    (deps.memberFollowUpsService ?? none) as never,
  );
}

const context = { organizationId: 'org-1', userId: 'trainer-1' };

describe('prepare_session_brief', () => {
  it('assembles evidence from scoped reads, inventing nothing', async () => {
    const executorService = executor({
      permissions: { hasPermission: jest.fn().mockResolvedValue(true) },
      membersService: {
        getOne: jest.fn().mockResolvedValue({ id: 'mem-1' }),
      },
      memberIntelligence: {
        getPtAdherence: jest.fn().mockResolvedValue({
          ptAdherencePct: 86,
          workoutsCompleted30d: 4,
          visits30d: 6,
          weeklyStreak: 3,
          insufficientData: false,
        }),
      },
      workoutAssignmentsService: {
        list: jest.fn().mockResolvedValue({
          items: [{ status: 'ACTIVE', workoutPlan: { name: 'Strength A' } }],
        }),
      },
      memberFollowUpsService: {
        list: jest
          .fn()
          .mockResolvedValue([
            { completedAt: null, dueAt: new Date(), title: 'Call about diet' },
          ]),
      },
    });
    // readMember path needs a fuller member shape; stub the service read.
    const membersService = (
      executorService as unknown as {
        membersService: { getOne: jest.Mock };
      }
    ).membersService;
    membersService.getOne.mockResolvedValue({
      id: 'mem-1',
      firstName: 'R',
      lastName: 'S',
      status: 'ACTIVE',
      joinedAt: '2026-01-01',
      primaryBranch: null,
      assignedTrainer: null,
      memberships: [],
    });
    const brief = (await executorService.execute(
      'prepare_session_brief',
      { memberId: 'mem-1' },
      context,
    )) as Record<string, unknown>;
    expect(brief).toMatchObject({
      adherence: expect.objectContaining({ ptAdherencePct: 86 }),
      activeAssignment: expect.objectContaining({ planName: 'Strength A' }),
    });
    expect(brief).toHaveProperty('openFollowUps');
  });

  it('passes branch before assignment scope to assignment reads', async () => {
    // Branch-scoped trainer: scoped check passes, org-wide fails, so the
    // requested branch becomes the scope (4th arg), assignment stays null.
    const hasPermission = jest.fn(
      async (_user: string, _org: string, key: string, scope?: string) =>
        key === 'workouts.read' && scope !== undefined,
    );
    const list = jest.fn().mockResolvedValue({ items: [] });
    const executorService = executor({
      permissions: { hasPermission },
      membersService: {
        getOne: jest.fn().mockResolvedValue({
          id: 'mem-1',
          firstName: 'R',
          lastName: 'S',
          status: 'ACTIVE',
          joinedAt: '2026-01-01',
          primaryBranch: null,
          assignedTrainer: null,
          memberships: [],
        }),
      },
      memberIntelligence: {
        getPtAdherence: jest.fn().mockResolvedValue({
          ptAdherencePct: null,
          workoutsCompleted30d: 0,
          visits30d: 0,
          weeklyStreak: 0,
          insufficientData: true,
        }),
      },
      workoutAssignmentsService: { list },
      memberFollowUpsService: { list: jest.fn().mockResolvedValue([]) },
    });
    await executorService.execute(
      'read_workout_history',
      { memberId: 'mem-1' },
      { ...context, requestedBranchId: 'br-1' },
    );
    // Regression: branch and assignment scopes used to be swapped here,
    // silently widening restricted trainers to the whole branch.
    expect(list).toHaveBeenCalledWith(
      'org-1',
      expect.anything(),
      'mem-1',
      null,
      'br-1',
    );
  });
});
