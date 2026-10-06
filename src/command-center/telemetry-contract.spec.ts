import { AiUsageCollector } from './collectors/ai-usage.collector';
import { AutomationCollector } from './collectors/automation.collector';
import { HttpCollector } from './collectors/http.collector';
import { HttpMetricsRing } from './collectors/http-metrics.ring';
import { MessagingCollector } from './collectors/messaging.collector';
import { QueueDepthCollector } from './collectors/queue.collector';
import { ReadinessCollector } from './collectors/readiness.collector';
import { TenantsCollector } from './collectors/tenants.collector';
import { WhatsappCollector } from './collectors/whatsapp.collector';
import type { Collector } from './collectors.types';
import {
  TELEMETRY_CONTRACT,
  missingContractKeys,
  type CardName,
} from './telemetry-contract';

/** A Prisma stand-in that answers every read with "nothing there". */
function emptyPrisma() {
  const model = {
    groupBy: jest.fn().mockResolvedValue([]),
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
    aggregate: jest.fn().mockResolvedValue({
      _sum: { costUsd: null, promptTokens: null, completionTokens: null },
    }),
  };
  return new Proxy(
    { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) },
    {
      get: (target, prop) =>
        prop in target ? target[prop as keyof typeof target] : model,
    },
  ) as never;
}

function allCollectors(): Collector[] {
  const prisma = emptyPrisma();
  const queue = {
    getJobCounts: jest.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
    }),
    isPaused: jest.fn().mockResolvedValue(false),
  };
  return [
    new ReadinessCollector(prisma, {
      client: { ping: jest.fn().mockResolvedValue('PONG') },
    } as never),
    new QueueDepthCollector({ notifications: queue } as never),
    new AiUsageCollector(prisma),
    new HttpCollector(new HttpMetricsRing()),
    new WhatsappCollector(prisma),
    new MessagingCollector(prisma),
    new AutomationCollector(prisma),
    new TenantsCollector(prisma),
  ];
}

/**
 * The contract is only worth anything if something holds collectors to it.
 * This is that something: a renamed field fails here instead of quietly
 * blanking a number on the console.
 */
describe('telemetry contract', () => {
  it('has exactly one collector per contract card', () => {
    const names = allCollectors()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(Object.keys(TELEMETRY_CONTRACT).sort());
  });

  it.each(allCollectors().map((c) => [c.name, c] as const))(
    '%s emits every key the console renders',
    async (name, collector) => {
      const result = await collector.collect();
      expect(result.value).not.toBeNull();
      expect(missingContractKeys(name as CardName, result.value)).toEqual([]);
    },
  );

  it('names the missing paths, nested ones included', () => {
    expect(
      missingContractKeys('tenants', { total: 1, trial: 1, active: 0 }),
    ).toEqual(['suspended', 'cancelled', 'newLast7Days']);
    expect(
      missingContractKeys('ai', {
        requests: 0,
        success: 0,
        errors: 0,
        costUsd: null,
        tokens: { prompt: 0 },
        actions: {},
      }),
    ).toEqual(
      expect.arrayContaining(['tokens.completion', 'actions.pendingApproval']),
    );
    expect(missingContractKeys('tenants', null)).toHaveLength(6);
  });
});
