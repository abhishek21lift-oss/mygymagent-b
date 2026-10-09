import { JOB_NAMES } from '../queue/queue.constants';
import { WebhookDispatcherService } from './webhook-dispatcher.service';

const SUB_STAR = {
  id: 's-star',
  organizationId: 'o1',
  url: 'https://hooks.example.com/a',
  events: ['*'],
  secret: 'x',
  enabled: true,
};
const SUB_OTHER = {
  id: 's-other',
  organizationId: 'o1',
  url: 'https://hooks.example.com/b',
  events: ['message.sent'],
  secret: 'y',
  enabled: true,
};

const EVENT = {
  organizationId: 'o1',
  inboundMessageId: 'm1',
  from: '919876543211',
  matchedMemberId: null,
};

function service(subs: unknown[]) {
  const queue = { add: jest.fn(async () => undefined) };
  const prisma = {
    webhookSubscription: { findMany: jest.fn(async () => subs) },
    inboundMessage: {
      findUnique: jest.fn(
        async (): Promise<Record<string, unknown> | null> => ({
          from: '919876543211',
          body: 'hello',
          matchedMemberId: null,
          isGroup: false,
          groupJid: null,
        }),
      ),
    },
    webhookDelivery: {
      create: jest.fn(async ({ data }: { data: unknown }) => ({
        id: 'd1',
        ...(data as object),
      })),
    },
  };
  const svc = new WebhookDispatcherService(prisma as never, queue as never);
  return { svc, queue, prisma };
}

describe('WebhookDispatcherService.dispatchReceived', () => {
  it('fans out one job per matching subscription only', async () => {
    const { svc, queue, prisma } = service([SUB_STAR, SUB_OTHER]);
    await svc.dispatchReceived(EVENT);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledTimes(1);
    expect(prisma.webhookDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'o1',
        subscriptionId: 's-star',
        event: 'message.received',
      }),
      select: { id: true },
    });
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      JOB_NAMES.DELIVER_WEBHOOK,
      expect.objectContaining({
        subscriptionId: 's-star',
        deliveryId: 'd1',
        event: 'message.received',
        organizationId: 'o1',
      }),
      expect.objectContaining({ attempts: 3, jobId: 'wl-d1' }),
    );
  });

  it('sends nothing when the inbound row is gone', async () => {
    const { svc, queue, prisma } = service([SUB_STAR]);
    prisma.inboundMessage.findUnique.mockResolvedValue(null);
    await svc.dispatchReceived(EVENT);
    expect(queue.add).not.toHaveBeenCalled();
    expect(prisma.webhookDelivery.create).not.toHaveBeenCalled();
  });
});
