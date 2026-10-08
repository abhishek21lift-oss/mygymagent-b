import { QueueDepthCollector } from './queue.collector';

/**
 * Queue depth is the first real introspection this codebase has (nothing
 * previously called getJobCounts), and it is the card that makes "is the
 * worker keeping up" answerable at all.
 */
describe('QueueDepthCollector', () => {
  let queues: Record<string, { getJobCounts: jest.Mock; isPaused: jest.Mock }>;
  let collector: QueueDepthCollector;

  function counts(overrides: Record<string, number> = {}) {
    return {
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
      ...overrides,
    };
  }

  beforeEach(() => {
    queues = Object.fromEntries(
      ['notifications', 'automation', 'push', 'wa-send'].map((name) => [
        name,
        {
          getJobCounts: jest.fn().mockResolvedValue(counts()),
          isPaused: jest.fn().mockResolvedValue(false),
        },
      ]),
    );
    collector = new QueueDepthCollector(queues as never);
  });

  it('reports every registered queue, so a renamed or missing one is visible', async () => {
    const result = await collector.collect();

    expect(result.status).toBe('ok');
    expect(result.value?.queues.map((q) => q.name).sort()).toEqual([
      'automation',
      'notifications',
      'push',
      'wa-send',
    ]);
  });

  it('totals depth across queues', async () => {
    queues.notifications.getJobCounts.mockResolvedValue(
      counts({ waiting: 3, active: 1, failed: 2 }),
    );
    queues.push.getJobCounts.mockResolvedValue(counts({ delayed: 5 }));

    const result = await collector.collect();

    expect(result.value?.totals).toMatchObject({
      waiting: 3,
      active: 1,
      failed: 2,
      delayed: 5,
    });
  });

  it('degrades when work is backed up, so the console is not green while mail queues', async () => {
    queues.notifications.getJobCounts.mockResolvedValue(
      counts({ waiting: 500, failed: 12 }),
    );

    const result = await collector.collect();

    expect(result.status).toBe('degraded');
  });

  it('degrades on failures even when nothing is waiting', async () => {
    // The other half of the same judgement: an idle queue with a failure
    // count is still not healthy, and a card that only looked at `waiting`
    // would call this fine.
    queues.automation.getJobCounts.mockResolvedValue(counts({ failed: 1 }));

    const result = await collector.collect();

    expect(result.status).toBe('degraded');
  });

  it('marks one broken queue unavailable without losing the others', async () => {
    queues.push.getJobCounts.mockRejectedValue(new Error('MOVEDTO'));

    const result = await collector.collect();

    const push = result.value?.queues.find((q) => q.name === 'push');
    const notifications = result.value?.queues.find(
      (q) => q.name === 'notifications',
    );
    expect(push?.status).toBe('unavailable');
    expect(push?.depth).toBeNull();
    expect(notifications?.status).toBe('ok');
    // A single unreadable queue must not zero the totals, or the console
    // would report "no backlog" during the exact incident it exists for.
    expect(result.value?.totals.waiting).toBe(0);
    expect(result.status).toBe('degraded');
  });

  it('reports a paused queue as paused, since its jobs stop being worked', async () => {
    queues.notifications.isPaused.mockResolvedValue(true);
    queues.notifications.getJobCounts.mockResolvedValue(counts({ waiting: 4 }));

    const result = await collector.collect();
    const row = result.value?.queues.find((q) => q.name === 'notifications');

    expect(row?.depth?.paused).toBe(4);
    // A paused queue is not healthy, and the card must not read as idle.
    expect(result.status).toBe('degraded');
  });

  it('never reports a broken queue as depth zero', async () => {
    queues.push.getJobCounts.mockRejectedValue(new Error('down'));

    const result = await collector.collect();
    const push = result.value?.queues.find((q) => q.name === 'push');

    expect(push?.depth).toBeNull();
    expect(push?.depth).not.toBe(0);
  });
});
