import type { INestApplication } from '@nestjs/common';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';
import { createVerify, generateKeyPairSync } from 'crypto';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P1-1: push over FCM, end to end -- device registration, the
 * notification -> preference -> queue -> FCM path, and what happens to a
 * dead token -- against a local stand-in for Google that behaves like the
 * real thing where it matters: it verifies the RS256 service-account JWT
 * with the public key, demands the bearer token it issued, and answers a
 * dead registration token with FCM's own UNREGISTERED error shape.
 */

interface ReceivedPush {
  token: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

const PROJECT_ID = 'mga-push-test';
const DEAD_TOKEN = 'dead-token-uninstalled-app';
const ACCESS_TOKEN = 'fake-oauth-access-token';

describe('Push notifications over FCM (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let fcm: Server;
  const received: ReceivedPush[] = [];
  const tokenExchanges: Array<Record<string, unknown>> = [];
  const savedEnv: Record<string, string | undefined> = {};

  let ownerToken: string;
  let ownerId: string;
  let organizationId: string;
  let colleagueToken: string;

  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const clientEmail = `push@${PROJECT_ID}.iam.gserviceaccount.com`;

  const as = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  function readBody(req: import('http').IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => resolve(raw));
    });
  }

  function verifyJwt(jwt: string, expectedAud: string) {
    const [h, c, s] = jwt.split('.');
    const ok = createVerify('RSA-SHA256')
      .update(`${h}.${c}`)
      .verify(publicKey, Buffer.from(s, 'base64url'));
    if (!ok) throw new Error('bad signature');
    const header = JSON.parse(Buffer.from(h, 'base64url').toString()) as {
      alg: string;
    };
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString()) as {
      iss: string;
      aud: string;
      scope: string;
      exp: number;
      iat: number;
    };
    if (header.alg !== 'RS256') throw new Error('alg');
    if (claims.iss !== clientEmail || claims.aud !== expectedAud)
      throw new Error('iss/aud');
    if (claims.scope !== 'https://www.googleapis.com/auth/firebase.messaging')
      throw new Error('scope');
    if (claims.exp - claims.iat > 3600) throw new Error('lifetime');
    return claims;
  }

  async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const value = fn();
      if (value !== undefined) return value;
      if (Date.now() > until) throw new Error('timed out waiting');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  async function pollLog(
    where: import('@prisma/client').Prisma.MessageLogWhereInput,
    ms = 10_000,
  ) {
    const until = Date.now() + ms;
    for (;;) {
      const row = await prisma.messageLog.findFirst({ where });
      if (row) return row;
      if (Date.now() > until) throw new Error('timed out waiting for log');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  beforeAll(async () => {
    fcm = createServer((req, res) => {
      void (async () => {
        const raw = await readBody(req);
        const port = (fcm.address() as AddressInfo).port;
        const reply = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url === '/token') {
          const form = new URLSearchParams(raw);
          try {
            if (
              form.get('grant_type') !==
              'urn:ietf:params:oauth:grant-type:jwt-bearer'
            )
              throw new Error('grant_type');
            tokenExchanges.push(
              verifyJwt(
                form.get('assertion') ?? '',
                `http://127.0.0.1:${port}/token`,
              ),
            );
            return reply(200, { access_token: ACCESS_TOKEN, expires_in: 3600 });
          } catch (e) {
            return reply(400, {
              error: 'invalid_grant',
              error_description: String(e),
            });
          }
        }
        if (req.url === `/v1/projects/${PROJECT_ID}/messages:send`) {
          if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`)
            return reply(401, { error: { status: 'UNAUTHENTICATED' } });
          const { message } = JSON.parse(raw) as {
            message: {
              token: string;
              notification: { title: string; body: string };
              data?: Record<string, string>;
            };
          };
          if (message.token === DEAD_TOKEN) {
            return reply(404, {
              error: {
                code: 404,
                status: 'NOT_FOUND',
                message: 'Requested entity was not found.',
                details: [
                  {
                    '@type':
                      'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                    errorCode: 'UNREGISTERED',
                  },
                ],
              },
            });
          }
          received.push({
            token: message.token,
            title: message.notification.title,
            body: message.notification.body,
            data: message.data,
          });
          return reply(200, {
            name: `projects/${PROJECT_ID}/messages/${received.length}`,
          });
        }
        reply(404, {});
      })();
    });
    await new Promise<void>((r) => fcm.listen(0, '127.0.0.1', r));
    const port = (fcm.address() as AddressInfo).port;

    const env = {
      // base64, to exercise the form that survives newline-mangling hosts.
      FCM_SERVICE_ACCOUNT_JSON: Buffer.from(
        JSON.stringify({
          type: 'service_account',
          project_id: PROJECT_ID,
          client_email: clientEmail,
          private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        }),
      ).toString('base64'),
      FCM_TOKEN_URL: `http://127.0.0.1:${port}/token`,
      FCM_API_BASE_URL: `http://127.0.0.1:${port}`,
    };
    for (const [k, v] of Object.entries(env)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }

    ({ app } = await createTestApp());
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Push Test Gym',
        email: `push-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Push',
        lastName: 'Owner',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    ownerId = registered.body.data.user.id;
    organizationId = registered.body.data.organization.id;

    const branches = await as(ownerToken)(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    const invited = await as(ownerToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `push-colleague-${Date.now()}@example.com`,
          firstName: 'Push',
          lastName: 'Colleague',
          primaryBranchId: branches.body.data.items[0].id,
          roleKey: 'TRAINER',
          roleBranchId: branches.body.data.items[0].id,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    colleagueToken = app
      .get(TokensService)
      .signAccessToken(invited.body.data.id);
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (app) await app.close().catch(() => {});
    await new Promise<void>((r) => fcm.close(() => r()));
  });

  const register = (token: string, deviceToken: string) =>
    as(token)(
      request(app.getHttpServer())
        .post('/notifications/devices')
        .send({ token: deviceToken }),
    );

  it('reports push as configured', async () => {
    const res = await as(ownerToken)(
      request(app.getHttpServer()).get('/notifications/devices/status'),
    ).expect(200);
    expect(res.body.data).toEqual({ configured: true });
  });

  it('registers a device without ever returning its token', async () => {
    const res = await register(ownerToken, 'owner-phone-token').expect(201);
    expect(res.body.data.id).toBeDefined();
    expect(JSON.stringify(res.body)).not.toContain('owner-phone-token');

    const list = await as(ownerToken)(
      request(app.getHttpServer()).get('/notifications/devices'),
    ).expect(200);
    expect(list.body.data).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('owner-phone-token');
  });

  it('rejects a missing or padded registration body', async () => {
    await register(ownerToken, '').expect(400);
    await as(ownerToken)(
      request(app.getHttpServer())
        .post('/notifications/devices')
        .send({ token: 'x', platform: 'ANDROID' }),
    ).expect(400);
  });

  it('re-homes a token when someone else signs in on the same device', async () => {
    await register(ownerToken, 'shared-tablet-token').expect(201);
    await register(colleagueToken, 'shared-tablet-token').expect(201);

    const rows = await prisma.notificationDevice.findMany({
      where: { address: 'shared-tablet-token' },
    });
    // One row, now the colleague's: the owner must not keep receiving
    // pushes meant for whoever is using the tablet now.
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).not.toBe(ownerId);
  });

  it("will not remove another user's device", async () => {
    const theirs = await register(colleagueToken, 'colleague-phone').expect(
      201,
    );
    await as(ownerToken)(
      request(app.getHttpServer()).delete(
        `/notifications/devices/${theirs.body.data.id}`,
      ),
    ).expect(404);
    await as(colleagueToken)(
      request(app.getHttpServer()).delete(
        `/notifications/devices/${theirs.body.data.id}`,
      ),
    ).expect(200);
  });

  it('sends a test push signed with the service account', async () => {
    const before = received.length;
    const res = await as(ownerToken)(
      request(app.getHttpServer()).post('/notifications/devices/test'),
    ).expect(200);
    expect(res.body.data.devices).toBe(1);
    expect(res.body.data.results[0].ok).toBe(true);
    expect(received.slice(before)).toEqual([
      expect.objectContaining({
        token: 'owner-phone-token',
        title: 'Push is working',
      }),
    ]);
    // The JWT was verified against the public key by the fake server.
    expect(tokenExchanges.length).toBeGreaterThanOrEqual(1);
  });

  it('pushes a notification only to users who turned push on for its category', async () => {
    await as(ownerToken)(
      request(app.getHttpServer())
        .patch('/notifications/preferences/PAYMENTS')
        .send({ push: true }),
    ).expect(200);
    // The colleague has a device and a PAYMENTS preference row, but push
    // left off (the default) -- a row existing must not read as opted in.
    await register(colleagueToken, 'colleague-second-phone').expect(201);
    await as(colleagueToken)(
      request(app.getHttpServer())
        .patch('/notifications/preferences/PAYMENTS')
        .send({ email: false }),
    ).expect(200);

    const before = received.length;
    await app.get(NotificationsService).notifyOrganization(organizationId, {
      type: 'PAYMENT_RECORDED',
      category: 'PAYMENTS',
      title: 'Payment recorded',
      body: '₹2,000 from Asha',
      actionUrl: '/billing',
      entityId: `payment-${Date.now()}`,
    });

    const push = await waitFor(() =>
      received.slice(before).find((p) => p.title === 'Payment recorded'),
    );
    expect(push).toEqual({
      token: 'owner-phone-token',
      title: 'Payment recorded',
      body: '₹2,000 from Asha',
      data: { type: 'PAYMENT_RECORDED', category: 'PAYMENTS', url: '/billing' },
    });

    const device = await prisma.notificationDevice.findFirstOrThrow({
      where: { address: 'owner-phone-token' },
    });
    // The fake records the push before it replies, so the SENT row can
    // trail it by a moment.
    const sent = await pollLog({
      organizationId,
      channel: 'PUSH',
      recipient: `device:${device.id}`,
      templateKey: 'notification:PAYMENT_RECORDED',
    });
    expect(sent.status).toBe('SENT');
    expect(sent.providerMessageId).toMatch(
      /^projects\/mga-push-test\/messages\//,
    );

    // Give any stray job time to land, then confirm nothing reached the
    // colleague's phone.
    await new Promise((r) => setTimeout(r, 500));
    expect(
      received.slice(before).some((p) => p.token.startsWith('colleague')),
    ).toBe(false);
  });

  it('pushes even when the user muted the in-app bell for that category', async () => {
    await as(ownerToken)(
      request(app.getHttpServer())
        .patch('/notifications/preferences/INVENTORY')
        .send({ inApp: false, push: true }),
    ).expect(200);
    const before = received.length;
    const result = await app
      .get(NotificationsService)
      .notifyOrganization(organizationId, {
        type: 'INVENTORY_LOW',
        category: 'INVENTORY',
        title: 'Protein bars low',
        body: '3 left',
        recipientUserIds: [ownerId],
      });
    expect(result.created).toBe(0);
    await waitFor(() =>
      received.slice(before).find((p) => p.title === 'Protein bars low'),
    );
  });

  it('pushes a deduplicated event once, not once per repeat', async () => {
    const before = received.length;
    const input = {
      type: 'PAYMENT_RECORDED',
      category: 'PAYMENTS' as const,
      title: 'Duplicate check',
      body: 'once',
      dedupeKey: `dup-${Date.now()}`,
    };
    const notifications = app.get(NotificationsService);
    await notifications.notifyOrganization(organizationId, input);
    await notifications.notifyOrganization(organizationId, input);
    await waitFor(() =>
      received.slice(before).find((p) => p.title === 'Duplicate check'),
    );
    await new Promise((r) => setTimeout(r, 1000));
    expect(
      received.slice(before).filter((p) => p.title === 'Duplicate check'),
    ).toHaveLength(1);
  });

  it('deactivates a dead token instead of retrying it', async () => {
    const dead = await register(ownerToken, DEAD_TOKEN).expect(201);
    await app.get(NotificationsService).notifyOrganization(organizationId, {
      type: 'PAYMENT_RECORDED',
      category: 'PAYMENTS',
      title: 'To a dead phone',
      body: 'x',
      recipientUserIds: [ownerId],
      dedupeKey: `dead-${Date.now()}`,
    });
    const failed = await pollLog({
      recipient: `device:${dead.body.data.id}`,
      status: 'FAILED',
    });
    expect(failed.errorMessage).toMatch(/UNREGISTERED/);
    expect(failed.attempts).toBe(1);
    const device = await prisma.notificationDevice.findUniqueOrThrow({
      where: { id: dead.body.data.id },
    });
    expect(device.active).toBe(false);
  });

  it('unregisters by token on sign-out', async () => {
    const res = await as(ownerToken)(
      request(app.getHttpServer())
        .post('/notifications/devices/unregister')
        .send({ token: 'owner-phone-token' }),
    ).expect(200);
    expect(res.body.data).toEqual({ removed: true });
    const left = await prisma.notificationDevice.count({
      where: { address: 'owner-phone-token' },
    });
    expect(left).toBe(0);
  });
});
