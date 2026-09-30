// MUST stay first -- see the helper.
import { restoreWhatsappWebTestEnv } from './utils/whatsapp-web-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { CommunicationsService } from '../src/communications/communications.service';
import { WA_SOCKET_FACTORY } from '../src/whatsapp-web/whatsapp-web.types';
import { createTestApp, type RegisteredAccount } from './utils/test-app';
import { eventually, fakeWhatsapp } from './utils/fake-whatsapp';

/**
 * WhatsApp Web (Baileys) end to end, with a fake socket standing in for
 * WhatsApp: linking by QR and by pairing code, sending through the linked
 * number with its safeguards, receipts, replies, and the number being
 * unlinked or blocked from WhatsApp's side.
 */
describe('WhatsApp Web (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let gym: RegisteredAccount;
  let other: RegisteredAccount;
  const { sockets, factory, socketFor, answerAtOnce } = fakeWhatsapp();

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
  });

  async function register(name: string): Promise<RegisteredAccount> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `waweb-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    const branches = await as(token).get('/branches').expect(200);
    return {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  async function member(
    account: RegisteredAccount,
    phone: string,
    firstName = 'Asha',
  ) {
    const res = await as(account.accessToken)
      .post('/members')
      .send({
        primaryBranchId: account.branchId,
        firstName,
        lastName: 'Verma',
        phone,
      })
      .expect(201);
    return res.body.data.id as string;
  }

  const sendTo = (account: RegisteredAccount, memberId: string, text: string) =>
    as(account.accessToken)
      .post(`/members/${memberId}/communications/send`)
      .send({ channel: 'WHATSAPP', customBody: text });

  const logOf = (id: string) =>
    prisma.messageLog.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    app = (
      await createTestApp((b) =>
        b.overrideProvider(WA_SOCKET_FACTORY).useValue(factory),
      )
    ).app;
    prisma = new PrismaClient();
    gym = await register('Linked Number Gym');
    other = await register('Other Gym');
    // An Indian gym, so numbers saved without +91 still resolve.
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app?.close().catch(() => {});
    restoreWhatsappWebTestEnv();
  });

  describe('linking a number', () => {
    it('is off until someone links a number, and says the deployment supports it', async () => {
      const res = await as(gym.accessToken).get('/whatsapp-web').expect(200);
      expect(res.body.data).toMatchObject({
        available: true,
        status: 'DISCONNECTED',
        useForSending: false,
      });
    });

    it('refuses to link without the owner accepting the ban risk', async () => {
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({})
        .expect(400);
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: 'yes' })
        .expect(400);
      expect(
        sockets.filter((s) => s.organizationId === gym.organizationId),
      ).toHaveLength(0);
    });

    it('shows a QR to scan, and a pairing code when a number is given', async () => {
      const res = await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true, phoneNumber: '919800000001' })
        .expect(201);
      expect(res.body.data.status).toBe('PAIRING');

      socketFor(gym.organizationId).emit('connection.update', {
        qr: 'fake-qr-payload',
      });
      const status = await eventually(
        async () =>
          (await as(gym.accessToken).get('/whatsapp-web').expect(200)).body
            .data,
        (d) => Boolean(d.qrDataUrl && d.pairingCode),
      );
      expect(status.qrDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(status.pairingCode).toBe('ABCD1234');
      expect(socketFor(gym.organizationId).pairingRequestedFor).toBe(
        '919800000001',
      );

      const session = await prisma.whatsappWebSession.findUniqueOrThrow({
        where: { organizationId: gym.organizationId },
      });
      expect(session.riskAcceptedByUserId).toBe(gym.userId);
    });

    it('is connected once the phone scans, with the codes gone', async () => {
      const socket = socketFor(gym.organizationId);
      socket.user = { id: '919800000001:7@s.whatsapp.net' };
      socket.emit('connection.update', { connection: 'open' });
      const status = await eventually(
        async () =>
          (await as(gym.accessToken).get('/whatsapp-web').expect(200)).body
            .data,
        (d) => d.status === 'CONNECTED',
      );
      expect(status).toMatchObject({
        phoneNumber: '919800000001',
        qrDataUrl: null,
        pairingCode: null,
      });
    });

    it("leaves another gym's settings and sending untouched", async () => {
      const res = await as(other.accessToken).get('/whatsapp-web').expect(200);
      expect(res.body.data.status).toBe('DISCONNECTED');

      const memberId = await member(other, '+919811111111');
      const before = socketFor(gym.organizationId).sent.length;
      // The other gym has no WhatsApp at all: it goes to the Meta API, which
      // is not configured -- and never out of the first gym's number.
      await sendTo(other, memberId, 'Hello').expect(503);
      expect(socketFor(gym.organizationId).sent.length).toBe(before);
    });
  });

  describe('sending through the linked number', () => {
    let memberId: string;
    let logId: string;

    beforeAll(async () => {
      memberId = await member(gym, '98765 43210');
      await as(gym.accessToken)
        .patch('/whatsapp-web/settings')
        .send({ useForSending: true })
        .expect(200);
    });

    it("queues the message, then sends it to the number with +91, and records WhatsApp's id", async () => {
      const res = await sendTo(
        gym,
        memberId,
        'Your membership renews on Friday.',
      ).expect(201);
      expect(res.body.data.status).toBe('PENDING');
      logId = res.body.data.id;

      const log = await eventually(
        () => logOf(logId),
        (l) => l.status !== 'PENDING',
      );
      expect(log.status).toBe('SENT');
      expect(log.providerMessageId).toMatch(/^waweb:FAKE\d+$/);
      expect(socketFor(gym.organizationId).sent.at(-1)).toEqual({
        jid: '919876543210@s.whatsapp.net',
        text: 'Your membership renews on Friday.',
      });
    });

    it('moves the log forward on receipts, never back', async () => {
      const id = (await logOf(logId)).providerMessageId!.replace('waweb:', '');
      const socket = socketFor(gym.organizationId);
      socket.emit('messages.update', [
        { key: { id, fromMe: true }, update: { status: 3 } },
      ]);
      await eventually(
        () => logOf(logId),
        (l) => l.status === 'DELIVERED',
      );
      socket.emit('messages.update', [
        { key: { id, fromMe: true }, update: { status: 4 } },
      ]);
      await eventually(
        () => logOf(logId),
        (l) => l.status === 'READ',
      );
      socket.emit('messages.update', [
        { key: { id, fromMe: true }, update: { status: 3 } },
      ]);
      await new Promise((r) => setTimeout(r, 300));
      expect((await logOf(logId)).status).toBe('READ');
    });

    it("files a member's reply against them, and ignores group chats", async () => {
      const socket = socketFor(gym.organizationId);
      socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          {
            key: {
              remoteJid: '1234567890@lid',
              remoteJidAlt: '919876543210@s.whatsapp.net',
              fromMe: false,
            },
            message: { conversation: 'Is the gym open on Sunday?' },
          },
          {
            key: { remoteJid: '120363000000@g.us', fromMe: false },
            message: { conversation: 'group chatter' },
          },
        ],
      });
      const rows = await eventually(
        () =>
          prisma.inboundMessage.findMany({
            where: { organizationId: gym.organizationId },
          }),
        (r) => r.length > 0,
      );
      await new Promise((r) => setTimeout(r, 200));
      const all = await prisma.inboundMessage.findMany({
        where: { organizationId: gym.organizationId },
      });
      expect(all).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        from: '919876543210',
        body: 'Is the gym open on Sunday?',
        matchedMemberId: memberId,
      });
    });

    it("fails a number that isn't on WhatsApp without retrying", async () => {
      const noWa = await member(gym, '+919700000000', 'Ravi');
      socketFor(gym.organizationId).notOnWhatsapp.add('919700000000');
      const res = await sendTo(gym, noWa, 'Hi').expect(201);
      const log = await eventually(
        () => logOf(res.body.data.id),
        (l) => l.status !== 'PENDING',
      );
      expect(log.status).toBe('FAILED');
      expect(log.errorMessage).toMatch(/isn't on WhatsApp/);
    });

    it('refuses marketing messages outright, even to a member who opted in', async () => {
      await prisma.memberConsent.create({
        data: {
          organizationId: gym.organizationId,
          memberId,
          type: 'MARKETING',
          granted: true,
        },
      });
      const comms = app.get(CommunicationsService);
      await expect(
        comms.sendAdHoc({
          organizationId: gym.organizationId,
          channel: 'WHATSAPP',
          category: 'MARKETING',
          recipient: '+919876543210',
          memberId,
          body: '50% off this weekend!',
        }),
      ).rejects.toThrow(
        /Marketing messages can't be sent through WhatsApp Web/,
      );
      const log = await prisma.messageLog.findFirstOrThrow({
        where: { organizationId: gym.organizationId, category: 'MARKETING' },
        orderBy: { createdAt: 'desc' },
      });
      expect(log.status).toBe('FAILED');
    });

    it('stops at the daily limit', async () => {
      const { sentLast24h } = (
        await as(gym.accessToken).get('/whatsapp-web').expect(200)
      ).body.data;
      await as(gym.accessToken)
        .patch('/whatsapp-web/settings')
        .send({ dailyLimit: sentLast24h })
        .expect(200);
      const res = await sendTo(gym, memberId, 'One too many').expect(429);
      expect(res.body.error.message).toMatch(
        /Daily WhatsApp Web limit reached/,
      );
      await as(gym.accessToken)
        .patch('/whatsapp-web/settings')
        .send({ dailyLimit: 200 })
        .expect(200);
    });
  });

  describe('the number being unlinked or blocked', () => {
    it('forgets the keys and stops sending when the phone unlinks it', async () => {
      await prisma.whatsappWebAuthKey.create({
        data: {
          organizationId: gym.organizationId,
          key: 'creds',
          valueEnc: 'v1.x.y.z',
        },
      });
      socketFor(gym.organizationId).emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } },
      });
      const session = await eventually(
        () =>
          prisma.whatsappWebSession.findUniqueOrThrow({
            where: { organizationId: gym.organizationId },
          }),
        (s) => s.status === 'LOGGED_OUT',
      );
      expect(session.useForSending).toBe(false);
      expect(session.lastError).toMatch(/unlinked from the phone/);
      expect(
        await prisma.whatsappWebAuthKey.count({
          where: { organizationId: gym.organizationId },
        }),
      ).toBe(0);
    });

    it('says so plainly when WhatsApp blocks the number', async () => {
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      const socket = socketFor(gym.organizationId);
      socket.user = { id: '919800000001@s.whatsapp.net' };
      socket.emit('connection.update', { connection: 'open' });
      await eventually(
        () =>
          prisma.whatsappWebSession.findUniqueOrThrow({
            where: { organizationId: gym.organizationId },
          }),
        (s) => s.status === 'CONNECTED',
      );
      socket.emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 403 } } },
      });
      const session = await eventually(
        () =>
          prisma.whatsappWebSession.findUniqueOrThrow({
            where: { organizationId: gym.organizationId },
          }),
        (s) => s.status === 'LOGGED_OUT',
      );
      expect(session.lastError).toMatch(/blocked or restricted/);
    });

    it('logs the device out when staff unlink it', async () => {
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      const socket = socketFor(gym.organizationId);
      socket.emit('connection.update', { connection: 'open' });
      await eventually(
        () =>
          prisma.whatsappWebSession.findUniqueOrThrow({
            where: { organizationId: gym.organizationId },
          }),
        (s) => s.status === 'CONNECTED',
      );
      const res = await as(gym.accessToken)
        .post('/whatsapp-web/disconnect')
        .expect(201);
      expect(res.body.data).toMatchObject({
        status: 'DISCONNECTED',
        useForSending: false,
        phoneNumber: null,
      });
      expect(socket.loggedOut).toBe(true);
    });

    it('will not send through the number once it is unlinked', async () => {
      await as(gym.accessToken)
        .patch('/whatsapp-web/settings')
        .send({ useForSending: true })
        .expect(400);
    });
  });

  describe('when WhatsApp does not answer', () => {
    const session = () =>
      prisma.whatsappWebSession.findUniqueOrThrow({
        where: { organizationId: gym.organizationId },
      });

    it('stops waiting and says why, instead of spinning forever', async () => {
      const before = sockets.length;
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      expect(sockets.length).toBe(before + 1);
      // No QR, no open, no close: the server cannot reach WhatsApp.
      const s = await eventually(
        session,
        (x) => x.status === 'DISCONNECTED',
        10_000,
      );
      expect(s.lastError).toMatch(/didn't answer the server within 3 seconds/);
      expect(socketFor(gym.organizationId).ended).toBe(true);
      const res = await as(gym.accessToken).get('/whatsapp-web').expect(200);
      expect(res.body.data).toMatchObject({
        status: 'DISCONNECTED',
        qrDataUrl: null,
      });
    });

    it('shows each failed attempt, and gives up after three', async () => {
      const failure = () =>
        Object.assign(new Error('Connection Failure'), {
          output: { statusCode: 405 },
        });
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);

      socketFor(gym.organizationId).emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: failure() },
      });
      const first = await eventually(session, (x) =>
        /Retrying/.test(x.lastError ?? ''),
      );
      expect(first).toMatchObject({ status: 'PAIRING' });
      expect(first.lastError).toMatch(/code 405: Connection Failure/);

      for (let attempt = 2; attempt <= 3; attempt++) {
        const count = sockets.length;
        await eventually(
          async () => sockets.length,
          (n) => n > count,
          10_000,
        );
        socketFor(gym.organizationId).emit('connection.update', {
          connection: 'close',
          lastDisconnect: { error: failure() },
        });
      }
      const last = await eventually(
        session,
        (x) => x.status === 'DISCONNECTED',
      );
      expect(last.lastError).toMatch(
        /Couldn't connect to WhatsApp after 3 tries \(code 405: Connection Failure\)/,
      );
    });
  });

  describe('when WhatsApp answers at once', () => {
    const session = () =>
      prisma.whatsappWebSession.findUniqueOrThrow({
        where: { organizationId: gym.organizationId },
      });
    const failure = () =>
      Object.assign(new Error('Connection Failure'), {
        output: { statusCode: 405 },
      });
    const failNow = () =>
      socketFor(gym.organizationId).emit('connection.update', {
        connection: 'close',
        lastDisconnect: { error: failure() },
      });
    const nextSocket = (count: number, ms: number) =>
      eventually(
        async () => sockets.length,
        (n) => n > count,
        ms,
      );

    afterEach(async () => {
      answerAtOnce(null);
      await as(gym.accessToken).post('/whatsapp-web/disconnect').expect(201);
    });

    it('hears it, even while the server is still getting ready', async () => {
      answerAtOnce((socket) =>
        socket.emit('connection.update', { qr: 'instant-qr' }),
      );
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      const status = await eventually(
        async () =>
          (await as(gym.accessToken).get('/whatsapp-web').expect(200)).body
            .data,
        (d) => Boolean(d.qrDataUrl),
        3_000,
      );
      expect(status).toMatchObject({ status: 'PAIRING' });
    });

    it('keeps retrying when the first try fails straight away', async () => {
      const count = sockets.length;
      answerAtOnce((socket) =>
        socket.emit('connection.update', {
          connection: 'close',
          lastDisconnect: { error: failure() },
        }),
      );
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      const s = await eventually(session, (x) =>
        /Retrying/.test(x.lastError ?? ''),
      );
      expect(s.status).toBe('PAIRING');
      answerAtOnce(null);
      await nextSocket(count + 1, 3_000);
    });

    it('starts a new link with short retries, not where the last one gave up', async () => {
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      failNow();
      for (let attempt = 2; attempt <= 3; attempt++) {
        await nextSocket(sockets.length, 10_000);
        failNow();
      }
      await eventually(session, (x) => x.status === 'DISCONNECTED');

      // A fresh start: the first retry comes after a second, as it did
      // the first time -- not after the doubled wait the last link had
      // built up.
      await as(gym.accessToken)
        .post('/whatsapp-web/connect')
        .send({ acceptRisk: true })
        .expect(201);
      const count = sockets.length;
      failNow();
      await nextSocket(count, 2_500);
    });
  });
});
