import { ScheduledMessageService } from './scheduled-message.service';

function service() {
  const created = {
    id: 'sched-1',
    organizationId: 'o1',
    status: 'PENDING',
  };
  const prisma = {
    scheduledMessage: {
      create: jest.fn(async () => created),
      findMany: jest.fn(async () => [created]),
      findFirst: jest.fn(async () => ({
        ...created,
        body: 'Hi',
        recipient: '+9198',
      })),
      update: jest.fn(async () => ({ id: 'sched-1', status: 'CANCELLED' })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
  };
  const queue = {
    add: jest.fn(async (..._args: any[]) => ({})),
    remove: jest.fn(async () => ({})),
  };
  const communications = {
    sendAdHoc: jest.fn(async () => ({ id: 'log-1', status: 'SENT' })),
  };
  const svc = new ScheduledMessageService(
    prisma as never,
    communications as never,
    queue as never,
  );
  return { svc, prisma, queue, communications, created };
}

const future = () => new Date(Date.now() + 3_600_000).toISOString();

describe('ScheduledMessageService.schedule', () => {
  it('stores a PENDING row and enqueues a delayed job', async () => {
    const { svc, prisma, queue } = service();
    const row = await svc.schedule('o1', 'u1', {
      to: '+919876543210',
      text: 'Reminder!',
      sendAt: future(),
    });
    expect(row.id).toBe('sched-1');
    expect(prisma.scheduledMessage.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PENDING' }),
      }),
    );
    const calls = queue.add.mock.calls as Array<
      [unknown, unknown, { jobId: string; delay: number }]
    >;
    expect(calls[0]![2].jobId).toBe('wa-sched-sched-1');
    expect(calls[0]![2].delay).toBeGreaterThan(0);
  });

  it('rejects past datetimes and blank fields', async () => {
    const { svc } = service();
    await expect(
      svc.schedule('o1', 'u1', {
        to: '+9198',
        text: 'x',
        sendAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toThrow(/future/i);
    await expect(
      svc.schedule('o1', 'u1', { to: '  ', text: 'x', sendAt: future() }),
    ).rejects.toThrow(/required/i);
  });
});

describe('ScheduledMessageService.fire', () => {
  it('sends through the normal pipeline and marks SENT', async () => {
    const { svc, communications, prisma } = service();
    await svc.fire('sched-1');
    expect(communications.sendAdHoc).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'o1',
        channel: 'WHATSAPP',
        templateKey: 'scheduled',
      }),
    );
    expect(prisma.scheduledMessage.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'SENT' }),
      }),
    );
  });

  it('skips rows that are no longer PENDING', async () => {
    const { svc, communications, prisma } = service();
    prisma.scheduledMessage.findFirst.mockResolvedValueOnce({
      id: 'sched-1',
      organizationId: 'o1',
      body: 'Hi',
      recipient: '+9198',
      status: 'CANCELLED',
    });
    await svc.fire('sched-1');
    expect(communications.sendAdHoc).not.toHaveBeenCalled();
  });
});

describe('ScheduledMessageService.cancel', () => {
  it('cancels a pending row and removes the job', async () => {
    const { svc, queue } = service();
    await expect(svc.cancel('o1', 'sched-1')).resolves.toEqual(
      expect.objectContaining({ status: 'CANCELLED' }),
    );
    expect(queue.remove).toHaveBeenCalledWith('wa-sched-sched-1');
  });

  it('refuses rows that already fired', async () => {
    const { svc, prisma } = service();
    prisma.scheduledMessage.findFirst.mockResolvedValueOnce({
      id: 'sched-1',
      organizationId: 'o1',
      body: 'Hi',
      recipient: '+9198',
      status: 'SENT',
    });
    await expect(svc.cancel('o1', 'sched-1')).rejects.toThrow(
      /already sent or cancelled/i,
    );
  });
});
