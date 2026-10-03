import { ReadinessCollector } from './readiness.collector';

/**
 * Readiness reuses the same two dependencies /ready already probes, so the
 * two can never disagree about whether this instance can serve traffic.
 */
describe('ReadinessCollector', () => {
  let prisma: { $queryRaw: jest.Mock };
  let redis: { ping: jest.Mock };
  let collector: ReadinessCollector;

  beforeEach(() => {
    prisma = { $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };
    // QueueConnection is injected, not a bare IORedis, so the spec wraps the
    // fake client the same way the app does -- the constructor takes the
    // wrapper, not the client.
    collector = new ReadinessCollector(
      prisma as never,
      {
        client: redis,
      } as never,
    );
  });

  it('reports both dependencies up when they answer', async () => {
    const result = await collector.collect();

    expect(result.status).toBe('ok');
    expect(result.value).toMatchObject({ database: 'up', queue: 'up' });
  });

  it('degrades when the database is unreachable, naming which one failed', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await collector.collect();

    expect(result.status).toBe('degraded');
    expect(result.value).toMatchObject({ database: 'down', queue: 'up' });
  });

  it('degrades when the queue is unreachable', async () => {
    redis.ping.mockRejectedValue(new Error('redis gone'));

    const result = await collector.collect();

    expect(result.status).toBe('degraded');
    expect(result.value).toMatchObject({ database: 'up', queue: 'down' });
  });

  it('measures round-trip latency for the database', async () => {
    prisma.$queryRaw.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([]), 40)),
    );

    const result = await collector.collect();

    expect(result.value?.latencyMs.database).toBeGreaterThanOrEqual(30);
  });

  it('fails fast instead of hanging when Redis stops responding', async () => {
    // The same reason the readiness probe races its ping against a 2s
    // timeout: the shared connection sets maxRetriesPerRequest: null for
    // BullMQ's blocking commands, so a plain await would queue forever
    // rather than fail. A console card must never be the thing that hangs.
    redis.ping.mockImplementation(() => new Promise(() => {}));

    const result = await collector.collect();

    expect(result.status).toBe('degraded');
    expect(result.value).toMatchObject({ queue: 'down' });
  });
});
