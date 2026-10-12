import { WaSender } from './wa-sender.service';

function sender(
  profile: { autoResend: boolean; maxResendAttempts: number } | null,
  opts: { connected?: boolean; sentToday?: number; dailyLimit?: number } = {},
) {
  const queue = {
    add: jest.fn(
      async (
        _name: string,
        _payload: unknown,
        _opts: Record<string, unknown>,
      ) => ({}),
    ),
    connection: {
      client: {
        eval: jest.fn(async () => Date.now()),
      },
    },
  };
  const prisma = {
    whatsappWebSession: {
      findUnique: jest.fn(async () => ({ dailyLimit: opts.dailyLimit ?? 200 })),
    },
    messageLog: {
      count: jest.fn(async () => opts.sentToday ?? 0),
    },
    whatsappAutomationProfile: {
      findUnique: jest.fn(async () => profile),
    },
  };
  const manager = {
    getStatus: jest.fn(async () =>
      opts.connected === false ? 'DISCONNECTED' : 'CONNECTED',
    ),
  };
  const svc = new WaSender(
    prisma as never,
    manager as never,
    { client: queue.connection.client } as never,
    queue as never,
  );
  return { svc, queue };
}

const message = {
  organizationId: 'org_1',
  to: '919876543210@s.whatsapp.net',
  text: 'Hi',
  messageLogId: 'log-1',
};

describe('WaSender auto-resend', () => {
  it('retries a configured number of times when auto-resend is on', async () => {
    const { svc, queue } = sender({ autoResend: true, maxResendAttempts: 3 });
    await svc.enqueue(message);
    expect(queue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
      }),
    );
  });

  it('tries exactly once when auto-resend is off', async () => {
    const { svc, queue } = sender({ autoResend: false, maxResendAttempts: 5 });
    await svc.enqueue(message);
    expect(queue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        attempts: 1,
      }),
    );
    // No backoff on a single attempt.
    const singleAttemptOpts = queue.add.mock.calls[0][2];
    expect(singleAttemptOpts).not.toHaveProperty('backoff');
  });

  it('keeps the legacy 8-attempt behavior for gyms with no saved profile', async () => {
    const { svc, queue } = sender(null);
    await svc.enqueue(message);
    expect(queue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ attempts: 8 }),
    );
  });

  it('bounds a saved value that exceeds the cap', async () => {
    const { svc, queue } = sender({ autoResend: true, maxResendAttempts: 99 });
    await svc.enqueue(message);
    expect(queue.add).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ attempts: 8 }),
    );
  });

  it('never enqueues twice for the same message log (idempotent jobId)', async () => {
    const { svc, queue } = sender({ autoResend: true, maxResendAttempts: 4 });
    await svc.enqueue(message);
    await svc.enqueue(message);
    expect(queue.add.mock.calls[0][2].jobId).toBe('wa-log-1');
    expect(queue.add.mock.calls[1][2].jobId).toBe('wa-log-1');
  });
});
