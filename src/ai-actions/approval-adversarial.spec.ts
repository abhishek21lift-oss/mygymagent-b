import 'reflect-metadata';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { AiActionsService } from './ai-actions.service';

function pendingAction(overrides: Record<string, unknown> = {}) {
  return {
    id: 'act-1',
    organizationId: 'org-1',
    type: 'ASSIGN_WORKOUT_PLAN',
    status: 'PENDING_APPROVAL',
    proposedByUserId: 'proposer-1',
    payload: { memberId: 'mem-1', planId: 'plan-1' },
    ...overrides,
  };
}

function serviceWith(action: Record<string, unknown> | null) {
  const prisma = {
    aiAction: {
      // Mirror the real query: org-scoped lookup, null when it matches nothing.
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (!action) return null;
        if (where.id && where.id !== action.id) return null;
        if (
          where.organizationId &&
          where.organizationId !== action.organizationId
        ) {
          return null;
        }
        return action;
      }),
      update: jest.fn().mockImplementation(async ({ data }) => ({
        ...(action ?? {}),
        ...data,
      })),
    },
    workoutAssignment: { create: jest.fn().mockResolvedValue({ id: 'wa-1' }) },
  };
  const permissions = {
    hasPermission: jest.fn().mockResolvedValue(true),
  };
  const service = new AiActionsService(
    prisma as never,
    permissions as never,
    {} as never,
    {} as never,
  );
  return { prisma, permissions, service };
}

describe('AiActionsService approval adversarial cases', () => {
  it('refuses cross-organization approval with NotFound, not data', async () => {
    const { service, prisma } = serviceWith(pendingAction());
    await expect(
      service.approve('org-EVIL', 'act-1', 'approver-1'),
    ).rejects.toThrow('AI action not found');
    expect(prisma.aiAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organizationId: 'org-EVIL' }),
      }),
    );
  });

  it('refuses self-approval even with the right permission', async () => {
    const { service } = serviceWith(pendingAction());
    await expect(
      service.approve('org-1', 'act-1', 'proposer-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses approval without the domain permission', async () => {
    const { service, permissions } = serviceWith(pendingAction());
    permissions.hasPermission.mockResolvedValue(false);
    await expect(
      service.approve('org-1', 'act-1', 'approver-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to approve a non-pending action (replay/double-approve)', async () => {
    const { service } = serviceWith(pendingAction({ status: 'EXECUTED' }));
    await expect(
      service.approve('org-1', 'act-1', 'approver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to approve after rejection', async () => {
    const { service } = serviceWith(pendingAction({ status: 'REJECTED' }));
    await expect(
      service.approve('org-1', 'act-1', 'approver-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses to reject a non-pending action', async () => {
    const { service } = serviceWith(pendingAction({ status: 'APPROVED' }));
    await expect(
      service.reject('org-1', 'act-1', 'approver-1', 'too late'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('AiActionsService.effectiveness', () => {
  it('reports counts plus null-safe acceptance and execution rates', async () => {
    const prisma = {
      aiAction: {
        groupBy: jest.fn().mockResolvedValue([
          { status: 'EXECUTED', _count: 8 },
          { status: 'REJECTED', _count: 2 },
          { status: 'PENDING_APPROVAL', _count: 5 },
        ]),
      },
    };
    const service = new AiActionsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.effectiveness('org-1');
    expect(result).toMatchObject({
      total: 15,
      pending: 5,
      approved: 0,
      executed: 8,
      rejected: 2,
      failed: 0,
      acceptanceRate: 80,
      executionRate: 100,
    });
    expect(prisma.aiAction.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org-1' } }),
    );
  });

  it('returns null rates instead of NaN with no decided actions', async () => {
    const prisma = {
      aiAction: { groupBy: jest.fn().mockResolvedValue([]) },
    };
    const service = new AiActionsService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const result = await service.effectiveness('org-1');
    expect(result).toMatchObject({
      total: 0,
      acceptanceRate: null,
      executionRate: null,
    });
  });
});
