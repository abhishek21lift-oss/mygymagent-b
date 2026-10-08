// MUST stay first -- see the helper.
import { restoreWaAuthTestEnv } from './utils/wa-auth-test-env';
import type { INestApplication } from '@nestjs/common';
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

const GROUP = '120363012345678@g.us';

/**
 * P4 staff rules + bot over 1:1 and group chats.
 */
describe('WhatsApp staff replies (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let gym: RegisteredAccount;
  const sockets = new Map<string, ReturnType<typeof fakeSocket>>();
  const factory = {
    create: jest.fn(async (input: { organizationId: string }) => {
      const socket = fakeSocket();
      sockets.set(input.organizationId, socket);
      return socket;
    }),
  };

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
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

  function inboundGroup(participant: string | null, text: string) {
    sockets.get(gym.organizationId)!.emit('messages.upsert', {
      type: 'notify',
      messages: [
        {
          key: {
            remoteJid: GROUP,
            ...(participant
              ? { participant: `${participant}@s.whatsapp.net` }
              : {}),
            fromMe: false,
          },
          message: { conversation: text },
        },
      ],
    });
  }

  async function ruleLogs() {
    return prisma.messageLog.findMany({
      where: {
        organizationId: gym.organizationId,
        templateKey: { startsWith: 'auto_reply.' },
      },
      select: { templateKey: true, recipient: true },
    });
  }

  async function makeRule(
    keyword: string,
    answer: string,
    scope = 'ALL',
    matchType = 'EXACT',
  ) {
    return prisma.autoReplyRule.create({
      data: {
        organizationId: gym.organizationId,
        keyword,
        answer,
        scope: scope as never,
        matchType: matchType as never,
        createdByUserId: gym.userId,
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
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
        organizationName: 'Reply Gym',
        email: `wareply-${suffix}@example.com`,
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
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
    await prisma.whatsappWebSession.upsert({
      where: { organizationId: gym.organizationId },
      create: {
        organizationId: gym.organizationId,
        status: 'DISCONNECTED',
        autoReply: true,
      },
      update: { autoReply: true },
    });
    await as(gym.accessToken)
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
    await prisma.$disconnect();
    await app?.close().catch(() => {});
    restoreWaAuthTestEnv();
  });

  it('answers a 1:1 keyword with the staff rule', async () => {
    await makeRule('offer', 'Diwali offer: 20% off!');
    inbound1to1('919876543211', 'offer');
    await eventually(
      async () => (await ruleLogs()).length,
      (n) => n >= 1,
    );
    const logs = await ruleLogs();
    expect(logs).toContainEqual({
      templateKey: 'auto_reply.rule',
      recipient: '919876543211',
    });
  }, 60_000);

  it('answers group keywords to the group, and skips LID-only senders', async () => {
    await makeRule('timing', 'Open 6am-10pm', 'ALL', 'CONTAINS');
    inboundGroup('919876543212', 'timing batao');
    await eventually(
      async () =>
        (await ruleLogs()).filter((l) => l.recipient === GROUP).length,
      (n) => n >= 1,
    );
    const before = (await ruleLogs()).length;
    inboundGroup(null, 'timing batao');
    await new Promise((r) => setTimeout(r, 3000));
    expect((await ruleLogs()).length).toBe(before);
  }, 60_000);

  it('#stop silences and #start restores', async () => {
    await makeRule('price', 'Plans start Rs 1000');
    inbound1to1('919876543213', '#stop');
    await eventually(
      async () =>
        (await ruleLogs()).filter((l) => l.templateKey === 'auto_reply.bot')
          .length,
      (n) => n >= 1,
    );
    const silenced = (await ruleLogs()).length;
    inbound1to1('919876543213', 'price');
    await new Promise((r) => setTimeout(r, 3000));
    expect((await ruleLogs()).length).toBe(silenced);
    inbound1to1('919876543213', '#start');
    await eventually(
      async () =>
        (await ruleLogs()).filter((l) => l.templateKey === 'auto_reply.bot')
          .length,
      (n) => n >= 2,
    );
  }, 90_000);

  it('sends exactly one reply when rule and gym intent overlap', async () => {
    await makeRule('plans', 'Custom plans answer');
    const before = (await ruleLogs()).length;
    inbound1to1('919876543214', 'plans');
    await eventually(
      async () => (await ruleLogs()).length,
      (n) => n >= before + 1,
      30_000,
    );
    await new Promise((r) => setTimeout(r, 3000));
    expect((await ruleLogs()).length).toBe(before + 1);
  }, 90_000);

  it('an invalid regex never crashes and the gym fallback still answers', async () => {
    await makeRule('fee(s', 'Broken', 'ALL', 'REGEX');
    inbound1to1('919876543215', 'zyxq parking?');
    await eventually(
      async () =>
        (await ruleLogs()).filter((l) => l.templateKey === 'auto_reply.unknown')
          .length,
      (n) => n >= 1,
      30_000,
    );
  }, 90_000);
});
