import { WaSender } from './wa-sender.service';

function sender(overrides: {
  status?: string;
  prefs?: unknown;
  sentToday?: number;
} = {}) {
  const { status = 'CONNECTED', prefs = { dailyLimit: 200 }, sentToday = 0 } =
    overrides;
  const manager = { getStatus: jest.fn(async () => status) };
  const prisma = {
    whatsappWebSession: { findUnique: jest.fn(async () => prefs) },
    messageLog: { count: jest.fn(async () => sentToday) },
  };
  const queueConnection = {
    client: { eval: jest.fn(async () => Date.now()) },
  };
  const queue = { add: jest.fn(async () => ({})) };
  const svc = new WaSender(
    prisma as never,
    manager as never,
    queueConnection as never,
    queue as never,
  );
  return { svc, prisma, queue };
}

const msg = (overrides = {}) => ({
  organizationId: 'o1',
  to: '919876543210@s.whatsapp.net',
  text: 'Hello',
  messageLogId: 'log-1',
  ...overrides,
});

describe('WaSender.enqueue', () => {
  it('refuses MARKETING even with consent', async () => {
    const { svc, queue } = sender();
    await expect(
      sender().svc.enqueue(msg({ category: 'MARKETING' })),
    ).rejects.toThrow(/marketing/i);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues a connected gym message with a waakg placeholder id', async () => {
    const { svc, queue } = sender();
    const result = await svc.enqueue(msg());
    expect(result).toEqual({
      queued: true,
      providerMessageId: 'waakg:queued:log-1',
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('refuses when no number is linked, naming the fix', async () => {
    const { svc } = sender({ status: 'DISCONNECTED' });
    await expect(svc.enqueue(msg())).rejects.toThrow(/link it again/i);
  });

  it('refuses past the daily cap with 429', async () => {
    const { svc } = sender({ sentToday: 200 });
    const error = await svc.enqueue(msg()).catch((e) => e);
    expect(error?.status ?? error?.getStatus?.()).toBe(429);
  });
});
