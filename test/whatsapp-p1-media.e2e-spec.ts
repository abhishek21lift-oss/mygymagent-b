// MUST stay first -- see the helper.
import { restoreWaAuthTestEnv } from './utils/wa-auth-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { WA_SOCKET_FACTORY } from '../src/whatsapp-web/wa-types';
import type { WaSocket } from '../src/whatsapp-web/wa-types';
import { FileStorageService } from '../src/files/file-storage.service';
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

/** Minimal real JPEG (magic bytes only) -- passes sniffMimeType. */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('fake-image-body'),
]);
const PDF = Buffer.from('%PDF-1.4 fake pdf content');

/**
 * P1 rich-send: image-with-caption through the gym's linked number.
 */
describe('WhatsApp P1 media send (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let storage: FileStorageService;
  let gym: RegisteredAccount;
  let gymB: RegisteredAccount;
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

  async function registerGym(name: string) {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `wamedia-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: res.body.data.organization.id,
    } as RegisteredAccount;
  }

  async function linkGym(account: RegisteredAccount) {
    await as(account.accessToken)
      .post('/whatsapp-web/connect')
      .send({ acceptRisk: true })
      .expect(201);
    const socket = await eventually(
      async () => sockets.get(account.organizationId),
      (value) => !!value,
    );
    socket!.emit('connection.update', { connection: 'open' });
    await eventually(
      async () =>
        as(account.accessToken)
          .post('/whatsapp-web')
          .send({})
          .then((res) => res.status),
      (s) => s === 200 || s === 404,
    );
  }

  /** Uploads bytes to S3 and records the File row. Returns the File id. */
  async function storeFile(
    account: RegisteredAccount,
    buffer: Buffer,
    originalName: string,
    mimeType: string,
  ) {
    const { key } = await storage.upload({
      organizationId: account.organizationId,
      buffer,
      originalName,
      mimeType,
      pathPrefix: 'whatsapp',
    });
    const row = await prisma.file.create({
      data: {
        organizationId: account.organizationId,
        key,
        originalName,
        mimeType,
        sizeBytes: buffer.length,
        purpose: 'OTHER',
        uploadedByUserId: account.userId,
      },
      select: { id: true },
    });
    return row.id;
  }

  beforeAll(async () => {
    app = (
      await createTestApp((b) =>
        b.overrideProvider(WA_SOCKET_FACTORY).useValue(factory),
      )
    ).app;
    storage = app.get(FileStorageService);
    prisma = new PrismaClient();
    gym = await registerGym('Media Gym');
    gymB = await registerGym('Media Gym B');
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
    await linkGym(gym);
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await app?.close().catch(() => {});
    restoreWaAuthTestEnv();
  });

  it('sends an image with caption through the linked number', async () => {
    const mediaKey = await storeFile(gym, JPEG, 'offer.jpg', 'image/jpeg');
    const send = await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({ to: '9876543210', text: 'Diwali offer!', mediaKey })
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
    const socket = sockets.get(gym.organizationId)!;
    const [, content] = socket.sendMessage.mock.calls[0] as unknown as [
      string,
      { image: Buffer; caption: string },
    ];
    expect(Buffer.isBuffer(content.image)).toBe(true);
    expect(content.caption).toBe('Diwali offer!');
  }, 60_000);

  it('rejects another gym’s file', async () => {
    const otherKey = await storeFile(gymB, JPEG, 'other.jpg', 'image/jpeg');
    await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({ to: '9876543210', text: 'hi', mediaKey: otherKey })
      .expect(400);
  });

  it('sends without a quote when replyToMessageId is unknown', async () => {
    const mediaKey = await storeFile(gym, JPEG, 'plain.jpg', 'image/jpeg');
    const send = await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({
        to: '9876543210',
        text: 'no quote',
        mediaKey,
        replyToMessageId: 'WAMSG-UNKNOWN',
      })
      .expect(201);
    const settled = await eventually(
      () =>
        prisma.messageLog.findUniqueOrThrow({
          where: { id: send.body.data.id },
          select: { status: true },
        }),
      (row) => row.status !== 'PENDING',
    );
    expect(settled.status).toBe('SENT');
  }, 60_000);

  it('rejects non-image files', async () => {
    const pdfKey = await storeFile(gym, PDF, 'fees.pdf', 'application/pdf');
    await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({ to: '9876543210', text: 'hi', mediaKey: pdfKey })
      .expect(400);
  });

  it('rejects files over 10MB before queueing', async () => {
    const big = await prisma.file.create({
      data: {
        organizationId: gym.organizationId,
        key: 'org/x/missing.jpg',
        originalName: 'big.jpg',
        mimeType: 'image/jpeg',
        sizeBytes: 11 * 1024 * 1024,
        purpose: 'OTHER',
        uploadedByUserId: gym.userId,
      },
      select: { id: true },
    });
    await as(gym.accessToken)
      .post('/whatsapp/messages')
      .send({ to: '9876543210', text: 'hi', mediaKey: big.id })
      .expect(400);
  });
});
