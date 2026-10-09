import { NotFoundException } from '@nestjs/common';
import { AiInsightsService } from './ai-insights.service';
import { RiskEngineService } from './risk-engine.service';
import { SegmentsService } from './segments.service';

describe('SegmentsService branch scoping', () => {
  function segments(rules: unknown[]) {
    const prisma = {
      memberSegment: {
        findFirst: jest.fn().mockResolvedValue({ id: 's1', rules }),
      },
      member: { findMany: jest.fn().mockResolvedValue([]) },
    };
    return { svc: new SegmentsService(prisma as never), prisma };
  }

  it.each([[[]], [[{ field: 'riskLevel', operator: 'eq', value: 'LOW' }]]])(
    'filters members by primaryBranchId for a scoped caller (rules=%j)',
    async (rules) => {
      const { svc, prisma } = segments(rules);
      await svc.getSegmentMembers('o1', 's1', 100, 0, 'br-1');
      await svc.countSegmentMembers('o1', 's1', 'br-1');
      await svc.getSegmentPhones('o1', 's1', 'br-1');
      expect(prisma.member.findMany).toHaveBeenCalledTimes(3);
      for (const [args] of prisma.member.findMany.mock.calls) {
        expect(args.where).toEqual({
          organizationId: 'o1',
          deletedAt: null,
          primaryBranchId: 'br-1',
        });
      }
    },
  );

  it('leaves org-wide callers unfiltered', async () => {
    const { svc, prisma } = segments([]);
    await svc.getSegmentMembers('o1', 's1');
    expect(prisma.member.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'o1',
      deletedAt: null,
    });
  });
});

describe('member-id intelligence routes branch scoping', () => {
  function riskEngine(member: unknown) {
    const prisma = {
      member: { findFirst: jest.fn().mockResolvedValue(member) },
    };
    return { svc: new RiskEngineService(prisma as never), prisma };
  }

  it('404s a member outside the caller branch', async () => {
    const { svc, prisma } = riskEngine(null);
    await expect(
      svc.assertMemberInBranchScope('o1', 'm1', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.member.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ primaryBranchId: 'br-1' }),
      }),
    );
  });

  it('is a no-op for org-wide callers', async () => {
    const { svc, prisma } = riskEngine(null);
    await svc.assertMemberInBranchScope('o1', 'm1', null);
    expect(prisma.member.findFirst).not.toHaveBeenCalled();
  });

  it('never reaches the model for an out-of-branch member', async () => {
    const { svc: risk } = riskEngine(null);
    const openRouter = { chatCompletion: jest.fn() };
    const churn = { assessMemberChurn: jest.fn() };
    const insights = new AiInsightsService(
      openRouter as never,
      risk,
      churn as never,
      {} as never,
    );
    await expect(
      insights.generateMemberInsight('o1', 'm1', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      insights.generateChurnReason('o1', 'm1', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(churn.assessMemberChurn).not.toHaveBeenCalled();
    expect(openRouter.chatCompletion).not.toHaveBeenCalled();
  });
});
