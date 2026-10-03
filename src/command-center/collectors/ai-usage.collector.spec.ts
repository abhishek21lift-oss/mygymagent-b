import { AiUsageCollector } from './ai-usage.collector';
import { runCollector } from '../collectors.types';

/**
 * AI spend is the card most likely to be trusted and acted on (it decides
 * whether a tenant's AI access is a cost problem), so these tests are mostly
 * about NOT inventing a number.
 */
describe('AiUsageCollector', () => {
  let prisma: {
    aiUsageLog: {
      groupBy: jest.Mock;
      aggregate: jest.Mock;
    };
    aiAction: { groupBy: jest.Mock };
  };
  let collector: AiUsageCollector;

  beforeEach(() => {
    prisma = {
      aiUsageLog: { groupBy: jest.fn(), aggregate: jest.fn() },
      aiAction: { groupBy: jest.fn() },
    };
    collector = new AiUsageCollector(prisma as never);
  });

  it('sums only provider-reported cost, never a rate-card estimate', async () => {
    prisma.aiAction.groupBy.mockResolvedValue([]);
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      { _count: { _all: 10 }, status: 'SUCCESS' },
      { _count: { _all: 2 }, status: 'ERROR' },
    ]);
    prisma.aiUsageLog.aggregate.mockResolvedValue({
      _sum: { costUsd: '1.234567', promptTokens: 900, completionTokens: 100 },
    });

    const result = await collector.collect();

    expect(result.status).toBe('ok');
    expect(result.value).toMatchObject({
      requests: 12,
      success: 10,
      errors: 2,
      costUsd: 1.234567,
    });
  });

  it('leaves cost null when the provider never reported one', async () => {
    // costUsd is nullable precisely so an estimate cannot leak in (see the
    // AiUsageLog model comment). A card that showed 0 here would read as
    // "AI was free", which is a different and wrong claim.
    prisma.aiUsageLog.groupBy.mockResolvedValue([
      { _count: { _all: 4 }, status: 'SUCCESS' },
    ]);
    prisma.aiUsageLog.aggregate.mockResolvedValue({
      _sum: { costUsd: null, promptTokens: 10, completionTokens: 5 },
    });

    const result = await collector.collect();

    expect(result.value).toMatchObject({ requests: 4, costUsd: null });
    expect(result.value?.costUsd).not.toBe(0);
  });

  it('reports zero traffic honestly when nothing ran in the window', async () => {
    prisma.aiAction.groupBy.mockResolvedValue([]);
    prisma.aiUsageLog.groupBy.mockResolvedValue([]);
    prisma.aiUsageLog.aggregate.mockResolvedValue({
      _sum: { costUsd: null, promptTokens: null, completionTokens: null },
    });

    const result = await collector.collect();

    expect(result.status).toBe('ok');
    expect(result.value).toMatchObject({
      requests: 0,
      success: 0,
      errors: 0,
      costUsd: null,
    });
  });

  it('carries pending AI approvals so an operator can see the queue', async () => {
    prisma.aiUsageLog.groupBy.mockResolvedValue([]);
    prisma.aiUsageLog.aggregate.mockResolvedValue({ _sum: {} });
    prisma.aiAction.groupBy.mockResolvedValue([
      { _count: { _all: 3 }, status: 'PENDING_APPROVAL' },
      { _count: { _all: 5 }, status: 'EXECUTED' },
      { _count: { _all: 1 }, status: 'FAILED' },
    ]);

    const result = await collector.collect();

    expect(result.value).toMatchObject({
      actions: { pendingApproval: 3, executed: 5, failed: 1 },
    });
  });

  it('reports an unreachable database as unavailable rather than as zero spend', async () => {
    // A collector does not grade its own failures -- runCollector does, so
    // that grading lives in exactly one place. This asserts the pair behaves
    // correctly end to end, which is the property the snapshot depends on.
    prisma.aiAction.groupBy.mockRejectedValue(new Error('db down'));
    prisma.aiUsageLog.groupBy.mockRejectedValue(new Error('db down'));
    prisma.aiUsageLog.aggregate.mockRejectedValue(new Error('db down'));

    const result = await runCollector(collector);

    expect(result.status).toBe('unavailable');
    expect(result.value).toBeNull();
    expect(result.unavailableReason).toContain('db down');
  });
});
