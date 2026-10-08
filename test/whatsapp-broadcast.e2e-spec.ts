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

/**
 * P3 segment broadcast: one message fanned out per member, progress
 * counted at settle time.
 */
describe('WhatsApp broadcast (e2e)', () => {
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
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      request(server()).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function makeMember(phone: string | null) {
    const res = await as(gym.accessToken)
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName: 'Cast',
        lastName: `M${Math.random().toString(36).slice(2, 6)}`,
        ...(phone ? { phone } : {}),
      })
      .expect(201);
    return res.body.data.id as string;
  }

  async function makeSegment() {
    // Empty rules match every member (resolveSegmentMembers short-circuit).
    const row = await prisma.memberSegment.create({
      data: {
        organizationId: gym.organizationId,
        name: `Bcast ${Date.now()}`,
        rules: [],
        isSystem: false,
        createdByUserId: gym.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  async function broadcastStatus(id: string) {
    return as(gym.accessToken)
      .get(`/whatsapp/broadcasts/${id}`)
      .expect(200)
      .then((res) => res.body.data);
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
        organizationName: 'Broadcast Gym',
        email: `wabcast-${suffix}@example.com`,
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

  it('sends now to every segment member and reaches DONE', async () => {
    await makeMember('+919876543211');
    await makeMember('+919876543212');
    await makeMember('+919876543213');
    const segmentId = await makeSegment();
    const created = await as(gym.accessToken)
      .post('/whatsapp/broadcasts')
      .send({ segmentId, text: 'Fees due reminder' })
      .expect(201);
    const id: string = created.body.data.id;
    const done = await eventually(
      () => broadcastStatus(id),
      (b) => b.status === 'DONE',
      120_000,
    );
    expect(done.sent).toBe(3);
    const logs = await prisma.messageLog.findMany({
      where: { broadcastId: id },
      select: { status: true },
    });
    expect(logs).toHaveLength(3);
    expect(logs.every((l) => l.status === 'SENT')).toBe(true);
  }, 180_000);

  it('schedules for the future without sending yet', async () => {
    const segmentId = await makeSegment();
    const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await as(gym.accessToken)
      .post('/whatsapp/broadcasts')
      .send({ segmentId, text: 'Later', sendAt })
      .expect(201);
    expect(created.body.data.status).toBe('PENDING');
    const progress = await broadcastStatus(created.body.data.id);
    expect(progress.queued).toBeGreaterThan(0);
    expect(progress.sent).toBe(0);
  });

  it('cancels a scheduled broadcast, and cancelling again is 404', async () => {
    const segmentId = await makeSegment();
    const sendAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const created = await as(gym.accessToken)
      .post('/whatsapp/broadcasts')
      .send({ segmentId, text: 'Never', sendAt })
      .expect(201);
    const id: string = created.body.data.id;
    await as(gym.accessToken).delete(`/whatsapp/broadcasts/${id}`).expect(200);
    await expect(broadcastStatus(id)).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await as(gym.accessToken).delete(`/whatsapp/broadcasts/${id}`).expect(404);
  });

  it('counts a limit-hit member as failed', async () => {
    // Daily cap is 200; burn it with direct sends is too slow -- instead
    // shrink the gym's limit to 0 via its session prefs.
    await prisma.whatsappWebSession.updateMany({
      where: { organizationId: gym.organizationId },
      data: { dailyLimit: 0 },
    });
    try {
      const segmentId = await makeSegment();
      const created = await as(gym.accessToken)
        .post('/whatsapp/broadcasts')
        .send({ segmentId, text: 'Capped' })
        .expect(201);
      const done = await eventually(
        () => broadcastStatus(created.body.data.id),
        (b) => b.status === 'DONE',
        60_000,
      );
      expect(done.failed).toBeGreaterThan(0);
      expect(done.sent).toBe(0);
    } finally {
      await prisma.whatsappWebSession.updateMany({
        where: { organizationId: gym.organizationId },
        data: { dailyLimit: 200 },
      });
    }
  }, 90_000);

  it('rejects a past sendAt with 400', async () => {
    const segmentId = await makeSegment();
    await as(gym.accessToken)
      .post('/whatsapp/broadcasts')
      .send({
        segmentId,
        text: 'Late',
        sendAt: new Date(Date.now() - 1000).toISOString(),
      })
      .expect(400);
  });
});
