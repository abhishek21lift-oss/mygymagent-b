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
 * WhatsApp sessions end to end, with a fake socket standing in for
 * WhatsApp: linking by QR, sending through the linked number, and the
 * number being unlinked from the phone's side.
 */
describe('WhatsApp sessions (e2e)', () => {
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
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
  });

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
        organizationName: 'Linked Number Gym',
        email: `wasess-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    gym = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: res.body.data.organization.id,
    };
    // An Indian gym, so numbers saved without +91 still resolve.
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app?.close().catch(() => {});
    restoreWaAuthTestEnv();
  });

  it('links by QR and sends through the linked number', async () => {
    const status = () =>
      as(gym.accessToken)
        .get('/whatsapp-web')
        .expect(200)
        .then((res) => res.body.data);

    await expect(status()).resolves.toMatchObject({ status: 'DISCONNECTED' });

    await as(gym.accessToken)
      .post('/whatsapp-web/connect')
      .send({ acceptRisk: true })
      .expect(201);

    const socket = await eventually(
      async () => sockets.get(gym.organizationId),
      (value) => !!value,
    );
    socket!.emit('connection.update', { qr: 'QR-PAYLOAD' });
    await expect(status()).resolves.toMatchObject({ status: 'PAIRING' });
    const pairing = await status();
    expect(pairing.qrDataUrl?.startsWith('data:image/')).toBe(true);

    socket!.emit('connection.update', { connection: 'open' });
    await expect(status()).resolves.toMatchObject({
      status: 'CONNECTED',
      phoneNumber: '919876543210',
    });

    const send = await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({ to: '9876543210', text: 'Hello from e2e' })
      .expect(201);
    const logId: string = send.body.data.id;
    const settled = await eventually(
      () =>
        prisma.messageLog.findUniqueOrThrow({
          where: { id: logId },
          select: { status: true, providerMessageId: true },
        }),
      (row) => row.status !== 'PENDING',
    );
    expect(settled).toMatchObject({
      status: 'SENT',
      providerMessageId: 'waakg:WAID1',
    });
  }, 60_000);
});
