import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { UnrecoverableError } from 'bullmq';
import { JOB_NAMES } from '../queue/queue.constants';
import { WebhookHttpError } from './webhook-send';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';

process.env.WEBHOOK_ALLOW_PRIVATE_URLS = '127.0.0.1';

let server: http.Server;
let base: string;
const seen: string[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push(req.url ?? '/');
      if (req.url === '/fail') res.writeHead(500).end('boom');
      else res.writeHead(200).end('ok');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  seen.length = 0;
});

function processor(sub: unknown) {
  const prisma = {
    webhookSubscription: { findFirst: jest.fn(async () => sub) },
    webhookDelivery: { update: jest.fn(async () => undefined) },
  };
  const svc = new WebhookDeliveryProcessor(prisma as never);
  return { svc, prisma };
}

function job(path: string, attemptsMade: number) {
  return {
    name: JOB_NAMES.DELIVER_WEBHOOK,
    data: {
      subscriptionId: 's1',
      deliveryId: 'd1',
      organizationId: 'o1',
      event: 'message.received',
      data: { from: '9198' },
    },
    attemptsMade,
    opts: { attempts: 3 },
  } as never;
}

describe('WebhookDeliveryProcessor', () => {
  it('marks SENT on 200', async () => {
    const { svc, prisma } = processor({
      id: 's1',
      organizationId: 'o1',
      url: `${base}/ok`,
      secret: 's',
      enabled: true,
    });
    await svc.process(job('/ok', 0));
    expect(seen).toEqual(['/ok']);
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        status: 'SENT',
        httpStatus: 200,
        attempts: 1,
      }),
    });
  });

  it('marks FAILED on the last attempt', async () => {
    const { svc, prisma } = processor({
      id: 's1',
      organizationId: 'o1',
      url: `${base}/fail`,
      secret: 's',
      enabled: true,
    });
    await expect(svc.process(job('/fail', 2))).rejects.toThrow(
      WebhookHttpError,
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        status: 'FAILED',
        httpStatus: 500,
        attempts: 3,
      }),
    });
  });

  it('rethrows retryable failures before the last attempt', async () => {
    const { svc, prisma } = processor({
      id: 's1',
      organizationId: 'o1',
      url: `${base}/fail`,
      secret: 's',
      enabled: true,
    });
    await expect(svc.process(job('/fail', 0))).rejects.toThrow(
      WebhookHttpError,
    );
    expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
      where: { id: 'd1' },
      data: expect.objectContaining({
        status: 'PENDING',
        attempts: 1,
        httpStatus: 500,
        error: 'Webhook receiver answered 500',
        nextRetryAt: expect.any(Date),
      }),
    });
  });

  it('recovers on retry: 500 then 200 marks SENT with 2 attempts', async () => {
    let calls = 0;
    const flapping = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        calls += 1;
        if (calls === 1) res.writeHead(500).end('boom');
        else res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      flapping.listen(0, '127.0.0.1', resolve),
    );
    const url = `http://127.0.0.1:${(flapping.address() as AddressInfo).port}/hook`;
    try {
      const { svc, prisma } = processor({
        id: 's1',
        organizationId: 'o1',
        url,
        secret: 's',
        enabled: true,
      });
      const data = {
        subscriptionId: 's1',
        deliveryId: 'd1',
        organizationId: 'o1',
        event: 'message.received',
        data: { from: '9198' },
      };
      await expect(
        svc.process({
          name: JOB_NAMES.DELIVER_WEBHOOK,
          data,
          attemptsMade: 0,
          opts: { attempts: 3 },
        } as never),
      ).rejects.toThrow(WebhookHttpError);
      await svc.process({
        name: JOB_NAMES.DELIVER_WEBHOOK,
        data,
        attemptsMade: 1,
        opts: { attempts: 3 },
      } as never);
      expect(prisma.webhookDelivery.update).toHaveBeenLastCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({
          status: 'SENT',
          httpStatus: 200,
          attempts: 2,
        }),
      });
    } finally {
      await new Promise((resolve) => flapping.close(resolve));
    }
  });

  it('never POSTs for a removed or disabled subscription', async () => {
    for (const sub of [null, { id: 's1', enabled: false }]) {
      seen.length = 0;
      const { svc, prisma } = processor(sub);
      await expect(svc.process(job('/ok', 0))).rejects.toThrow(
        UnrecoverableError,
      );
      expect(seen).toEqual([]);
      expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({
          status: 'FAILED',
          error: 'subscription removed',
        }),
      });
    }
  });

  it('rejects unknown jobs without touching the network', async () => {
    const { svc } = processor(null);
    await expect(
      svc.process({ name: 'nope', data: {}, attemptsMade: 0 } as never),
    ).rejects.toThrow(UnrecoverableError);
  });
});
