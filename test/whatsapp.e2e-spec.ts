import { createHmac } from 'crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-meta-verify-token';

/**
 * B-P0-2 (BACKLOG.md): first e2e coverage for src/whatsapp/ -- the send
 * path and the two @Public() Meta webhook routes.
 *
 * The send path's contract is the interesting one: with no connected
 * integration a send must FAIL LOUDLY (5xx + a FAILED MessageLog row), not
 * silently drop the message -- the guarantee ARCHITECTURE_DECISIONS.md AI-6
 * committed to when WhatsApp/SMS/push were left unwired. This suite proves
 * that, rather than asserting a happy path that would need real Meta
 * credentials.
 *
 * META_APP_SECRET / META_WABA_VERIFY_TOKEN are set before the app boots so
 * the webhook's HMAC check is exercised for real: unset, the service takes
 * a documented development bypass and accepts anything, which would make
 * the signature tests below vacuous. META_APP_ID is deliberately left unset
 * so nothing in this suite can reach Meta's Graph API over the network.
 */
describe('WhatsApp (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ownerToken: string;
  let organizationId: string;
  let limitedToken: string;
  const originalEnv: Record<string, string | undefined> = {};

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(ownerToken)(req);
  const asLimited = (req: request.Test) => authed(limitedToken)(req);

  /** The controller falls back to re-serializing the parsed body when
   * `rawBody` is absent (the test app is built without `rawBody: true`),
   * so the signature is computed over exactly that same serialization. */
  const sign = (payload: unknown) =>
    `sha256=${createHmac('sha256', APP_SECRET)
      .update(Buffer.from(JSON.stringify(payload)))
      .digest('hex')}`;

  beforeAll(async () => {
    originalEnv.META_APP_SECRET = process.env.META_APP_SECRET;
    originalEnv.META_WABA_VERIFY_TOKEN = process.env.META_WABA_VERIFY_TOKEN;
    process.env.META_APP_SECRET = APP_SECRET;
    process.env.META_WABA_VERIFY_TOKEN = VERIFY_TOKEN;

    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'WhatsApp Test Gym',
        email: `whatsapp-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Whats',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    organizationId = registered.body.data.organization.id;

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);

    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `whatsapp-accountant-${Date.now()}@example.com`,
          firstName: 'Limited',
          lastName: 'Accountant',
          primaryBranchId: branches.body.data.items[0].id,
          roleKey: 'ACCOUNTANT',
          roleBranchId: branches.body.data.items[0].id,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    limitedToken = app.get(TokensService).signAccessToken(invited.body.data.id);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe('integration status', () => {
    it('reports no integration before one is connected', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/whatsapp/integration'),
      ).expect(200);
      expect(res.body.data).toBeNull();
    });

    it('refuses embedded signup while Meta app credentials are unconfigured', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/whatsapp/integration/embedded-signup')
          .send({ code: 'fake-code', wabaId: 'fake-waba' }),
      ).expect(503);
    });

    it('reports a disconnect as a no-op when nothing is connected', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post('/whatsapp/disconnect'),
      ).expect(201);
      expect(res.body.data.disconnected).toBe(true);
      expect(res.body.data.credentialRemoved).toBe(false);
    });

    it('denies a caller without whatsapp.read', async () => {
      await asLimited(
        request(app.getHttpServer()).get('/whatsapp/integration'),
      ).expect(403);
    });
  });

  describe('send path', () => {
    it('fails loudly and records a FAILED message log when unconnected', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/whatsapp/messages')
          .send({ to: '15551234567', text: 'Your session is confirmed' }),
      ).expect(503);

      // The guarantee that matters: the attempt is visible as FAILED with a
      // real provider error, never silently dropped.
      const logs = await asOwner(
        request(app.getHttpServer()).get('/whatsapp/messages'),
      ).expect(200);
      const attempt = logs.body.data.find(
        (m: { recipient: string }) => m.recipient === '15551234567',
      );
      expect(attempt).toBeDefined();
      expect(attempt.status).toBe('FAILED');
      expect(attempt.channel).toBe('WHATSAPP');
      expect(attempt.errorMessage).toBeTruthy();
    });

    it('rejects an empty recipient or body before touching the provider', async () => {
      await asOwner(
        request(app.getHttpServer())
          .post('/whatsapp/messages')
          .send({ to: '   ', text: 'hello' }),
      ).expect(400);

      await asOwner(
        request(app.getHttpServer())
          .post('/whatsapp/messages')
          .send({ to: '15551234567', text: '   ' }),
      ).expect(400);
    });

    it('denies a caller without whatsapp.manage', async () => {
      await asLimited(
        request(app.getHttpServer())
          .post('/whatsapp/messages')
          .send({ to: '15551234567', text: 'nope' }),
      ).expect(403);
    });

    it('lists the org WhatsApp templates', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/whatsapp/templates'),
      ).expect(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(
        res.body.data.every(
          (t: { channel: string }) => t.channel === 'WHATSAPP',
        ),
      ).toBe(true);
    });
  });

  describe('webhook verification (GET)', () => {
    it('echoes the challenge verbatim for the correct verify token', async () => {
      const res = await request(app.getHttpServer())
        .get('/whatsapp/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': VERIFY_TOKEN,
          'hub.challenge': '1234567890',
        })
        .expect(200);
      // Meta requires the body to equal hub.challenge exactly -- not the
      // usual { data, meta } envelope.
      expect(res.text).toBe('1234567890');
    });

    it('rejects a wrong verify token', async () => {
      await request(app.getHttpServer())
        .get('/whatsapp/webhook')
        .query({
          'hub.mode': 'subscribe',
          'hub.verify_token': 'not-the-token',
          'hub.challenge': '1234567890',
        })
        .expect(403);
    });

    it('rejects a missing mode or challenge', async () => {
      await request(app.getHttpServer())
        .get('/whatsapp/webhook')
        .query({ 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'abc' })
        .expect(403);

      await request(app.getHttpServer())
        .get('/whatsapp/webhook')
        .query({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN })
        .expect(403);
    });
  });

  describe('webhook delivery (POST)', () => {
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: 'unknown-phone-number-id' },
                messages: [
                  {
                    from: '15557654321',
                    id: 'wamid.test',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'Hi, is the gym open?' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    it('accepts a correctly signed payload and acks unknown numbers', async () => {
      const res = await request(app.getHttpServer())
        .post('/whatsapp/webhook')
        .set('x-hub-signature-256', sign(payload))
        .send(payload)
        .expect(200);
      // Acked even though the phone_number_id maps to no org, so Meta stops
      // retrying an event nobody can route.
      expect(res.body.data.received).toBe(true);
    });

    it('rejects a payload whose signature does not match the body', async () => {
      await request(app.getHttpServer())
        .post('/whatsapp/webhook')
        .set('x-hub-signature-256', sign({ ...payload, object: 'tampered' }))
        .send(payload)
        .expect(403);
    });

    it('rejects a missing or malformed signature header', async () => {
      await request(app.getHttpServer())
        .post('/whatsapp/webhook')
        .send(payload)
        .expect(403);

      await request(app.getHttpServer())
        .post('/whatsapp/webhook')
        .set('x-hub-signature-256', 'md5=deadbeef')
        .send(payload)
        .expect(403);
    });

    it('does not file an inbound message for an unroutable phone number', async () => {
      const inbound = await prisma.inboundMessage.count({
        where: { organizationId },
      });
      expect(inbound).toBe(0);
    });
  });

  describe('inbound listing', () => {
    it('rejects a non-boolean matched filter', async () => {
      await asOwner(
        request(app.getHttpServer())
          .get('/whatsapp/inbound')
          .query({ matched: 'maybe' }),
      ).expect(400);
    });

    it('accepts an explicit true/false filter', async () => {
      for (const matched of ['true', 'false']) {
        const res = await asOwner(
          request(app.getHttpServer())
            .get('/whatsapp/inbound')
            .query({ matched }),
        ).expect(200);
        expect(Array.isArray(res.body.data)).toBe(true);
      }
    });
  });
});
