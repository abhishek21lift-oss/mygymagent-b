// MUST stay first -- see the helper.
import { restoreWaAuthTestEnv } from './utils/wa-auth-test-env';
import type { INestApplication } from '@nestjs/common';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { WA_SOCKET_FACTORY } from '../src/whatsapp-web/wa-types';
import type { WaSocket } from '../src/whatsapp-web/wa-types';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

function fakeSocket() {
  const handlers = new Map<string, (arg: any) => void>();
  const socket = {
    ev: {
      on: jest.fn((event: string, listener: (arg: any) => void) => {
        handlers.set(event, listener);
      }),
    },
    user: { id: '919876543210@s.whatsapp.net' },
    sendMessage: jest.fn(async () => ({ key: { id: 'WAID1' } })),
    onWhatsApp: jest.fn(async (...jids: string[]) =>
      jids.map((jid) => ({ jid, exists: true })),
    ),
    requestPairingCode: jest.fn(async () => 'PAIR-1'),
    logout: jest.fn(async () => undefined),
    end: jest.fn(() => undefined),
    emit: (event: string, arg: any) => handlers.get(event)?.(arg),
  };
  return socket as unknown as WaSocket & { emit: typeof socket.emit };
}

async function eventually<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (pred(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

interface Hit {
  url: string;
  signature: string | undefined;
  raw: string;
}

/**
 * P5 outgoing webhooks: subscribe → event → signed POST, retries, test.
 */
describe('WhatsApp webhooks (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let gym: RegisteredAccount;
  let receiver: http.Server;
  let base: string;
  const hits: Hit[] = [];
  const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
  const factory = {
    create: jest.fn(async (input: { organizationId: string }) => {
      const socket = fakeSocket();
      sockets.set(input.organizationId, socket);
      return socket;
    }),
  };

  const server = () => app.getHttpServer();
  const api = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      request(server()).delete(url).set('Authorization', `Bearer ${token}`),
  });

  function inbound1to1(from: string, text: string) {
    sockets.get(gym.organizationId)!.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: { remoteJid: `${from}@s.whatsapp.net`, fromMe: false },
          message: { conversation: text },
        },
      ],
    });
  }

  async function subscribe(url: string, events: string[]) {
    const res = await api(gym.accessToken)
      .post('/whatsapp/webhooks')
      .send({ url, events })
      .expect(201);
    return res.body.data as { id: string; secret: string };
  }

  beforeAll(async () => {
    receiver = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits.push({
          url: req.url ?? '/',
          signature: req.headers['x-webhook-signature'] as string | undefined,
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        if (req.url === '/fail') res.writeHead(500).end('boom');
        else res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;

    app = (
      await createTestApp((b) =>
        b.overrideProvider(WA_SOCKET_FACTORY).useValue(factory),
      )
    ).app;
    prisma = new PrismaClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Webhook Gym',
        email: `webhook-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    gym = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: res.body.data.user.primaryBranchId,
    };
    await prisma.whatsappWebSession.upsert({
      where: { organizationId: gym.organizationId },
      create: {
        organizationId: gym.organizationId,
        status: 'DISCONNECTED',
        autoReply: false,
      },
      update: { autoReply: false },
    });
    await api(gym.accessToken)
      .post('/whatsapp-web/connect')
      .send({ acceptRisk: true })
      .expect(201);
    const socket = await eventually(
      async () => sockets.get(gym.organizationId),
      (value) => !!value,
    );
    socket!.emit('connection.update', { connection: 'open' });
  }, 60_000);

  afterAll(async () => {
    await new Promise((resolve) => receiver.close(resolve));
    await prisma.$disconnect();
    await app?.close().catch(() => {});
    restoreWaAuthTestEnv();
  });

  it('rejects private URLs and unknown events with 400', async () => {
    await api(gym.accessToken)
      .post('/whatsapp/webhooks')
      .send({ url: 'http://192.168.1.5/hook', events: ['message.received'] })
      .expect(400);
    await api(gym.accessToken)
      .post('/whatsapp/webhooks')
      .send({ url: `${base}/ok`, events: ['group.update'] })
      .expect(400);
    await api(gym.accessToken)
      .post('/whatsapp/webhooks')
      .send({ url: `${base}/ok`, events: [] })
      .expect(400);
  }, 60_000);

  it('delivers a signed POST on inbound', async () => {
    const sub = await subscribe(`${base}/ok`, ['message.received']);
    inbound1to1('919876543211', 'hello gym');
    const hit = await eventually(
      async () => hits.find((h) => h.url === '/ok'),
      (value) => !!value,
      30_000,
    );
    expect(hit!.signature).toBe(
      `sha256=${crypto.createHmac('sha256', sub.secret).update(hit!.raw, 'utf8').digest('hex')}`,
    );
    const body = JSON.parse(hit!.raw);
    expect(body).toMatchObject({
      event: 'message.received',
      organizationId: gym.organizationId,
    });
    expect(body.data.from).toBe('919876543211');
    await api(gym.accessToken)
      .delete(`/whatsapp/webhooks/${sub.id}`)
      .expect(200);
  }, 60_000);

  it('retries a failing receiver then records FAILED with 3 attempts', async () => {
    const sub = await subscribe(`${base}/fail`, ['message.received']);
    inbound1to1('919876543212', 'hello again');
    const row = await eventually(
      async () =>
        prisma.webhookDelivery.findFirst({
          where: { subscriptionId: sub.id, status: 'FAILED' },
        }),
      (value) => !!value,
      260_000,
    );
    expect(row!.attempts).toBe(3);
    expect(row!.httpStatus).toBe(500);
    await api(gym.accessToken)
      .delete(`/whatsapp/webhooks/${sub.id}`)
      .expect(200);
  }, 300_000);

  it('test endpoint delivers exactly once and logs SENT', async () => {
    const sub = await subscribe(`${base}/ok`, ['*']);
    const before = hits.length;
    const res = await api(gym.accessToken)
      .post(`/whatsapp/webhooks/${sub.id}/test`)
      .expect(201);
    expect(res.body.data).toMatchObject({ ok: true, httpStatus: 200 });
    await eventually(
      async () => hits.length,
      (n) => n >= before + 1,
      30_000,
    );
    expect(hits.length).toBe(before + 1);
    const rows = await prisma.webhookDelivery.findMany({
      where: { subscriptionId: sub.id, event: 'test' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'SENT', attempts: 1 });
  }, 60_000);
});
