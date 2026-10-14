// MUST stay first -- see the helper.
import { restoreAdapterFlag } from './utils/whatsapp-adapter-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Read-only WhatsApp surfaces: adapter contact search, group metadata,
 * and webhook delivery history. Every route is authenticated,
 * permission-gated (whatsapp.read), tenant-scoped server-side, and
 * bounded -- one gym's contacts, groups, or deliveries never leak into
 * another's, and oversized inputs degrade to caps, never 500s.
 *
 * Write paths (subscriptions, test delivery) are used only to seed
 * delivery rows; no socket, message, or broadcast is ever sent.
 */
describe('WhatsApp read surfaces (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let other: RegisteredAccount;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);

    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);

    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    gym = await registerOrg('Read Surfaces Gym');
    other = await registerOrg('Read Surfaces Other Gym');

    // Gym A owns a session with three address-book rows; gym B owns
    // nothing. Rows are written directly: no socket ever connects.
    const session = await prisma.waSession.create({
      data: {
        organizationId: gym.organizationId,
        sessionId: `gym-${gym.organizationId}`,
      },
    });
    await prisma.waContact.createMany({
      data: [
        {
          sessionId: session.id,
          jid: '911234567890@s.whatsapp.net',
          name: 'Aarav Sharma',
          notify: 'Aarav',
        },
        {
          sessionId: session.id,
          jid: '919876543210@s.whatsapp.net',
          name: null,
          notify: 'Priya',
        },
        {
          sessionId: session.id,
          jid: '14085551212@s.whatsapp.net',
          name: 'Gym Front Desk',
          notify: null,
        },
      ],
    });
  });

  afterAll(async () => {
    restoreAdapterFlag();
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('searches contacts case-insensitively across jid, name, and notify', async () => {
    const byName = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?search=aarav',
      ),
    ).expect(200);
    expect(byName.body.data.map((c: { jid: string }) => c.jid)).toEqual([
      '911234567890@s.whatsapp.net',
    ]);

    const byNotify = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?search=PRIYA',
      ),
    ).expect(200);
    expect(byNotify.body.data.map((c: { jid: string }) => c.jid)).toEqual([
      '919876543210@s.whatsapp.net',
    ]);

    const byJid = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?search=14085551212',
      ),
    ).expect(200);
    expect(byJid.body.data).toHaveLength(1);

    const miss = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?search=nobody-here',
      ),
    ).expect(200);
    expect(miss.body.data).toEqual([]);
  });

  it('bounds contact listing and degrades oversized input to caps, never 500s', async () => {
    const all = await authed(gym.accessToken)(
      request(app.getHttpServer()).get('/whatsapp-adapter/contacts'),
    ).expect(200);
    expect(all.body.data).toHaveLength(3);

    const huge = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?limit=1000000',
      ),
    ).expect(200);
    expect(huge.body.data.length).toBeLessThanOrEqual(200);

    const garbage = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?limit=abc&search=' + 'x'.repeat(5000),
      ),
    ).expect(200);
    expect(Array.isArray(garbage.body.data)).toBe(true);
  });

  it('never reveals another organization\u2019s contacts', async () => {
    const res = await authed(other.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp-adapter/contacts?search=aarav',
      ),
    ).expect(200);
    expect(res.body.data).toEqual([]);

    const list = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/whatsapp-adapter/contacts'),
    ).expect(200);
    expect(list.body.data).toEqual([]);
  });

  it('reports groups unavailable (not error) with no open session, per tenant', async () => {
    for (const account of [gym, other]) {
      const res = await authed(account.accessToken)(
        request(app.getHttpServer()).get('/whatsapp-adapter/groups'),
      ).expect(200);
      expect(res.body.data).toEqual({ available: false, groups: [] });
    }

    const garbage = await authed(gym.accessToken)(
      request(app.getHttpServer()).get('/whatsapp-adapter/groups?limit=abc'),
    ).expect(200);
    expect(garbage.body.data).toEqual({ available: false, groups: [] });
  });

  it('requires authentication on the read surfaces', async () => {
    await request(app.getHttpServer())
      .get('/whatsapp-adapter/contacts')
      .expect(401);
    await request(app.getHttpServer())
      .get('/whatsapp-adapter/groups')
      .expect(401);
    await request(app.getHttpServer())
      .get('/whatsapp/webhooks/deliveries')
      .expect(401);
  });

  it('records delivery outcomes without secrets or bodies, scoped per tenant', async () => {
    // Seed one delivery via the test endpoint against a closed port:
    // fast, deterministic, and recorded FAILED -- never sent anywhere.
    const sub = await authed(gym.accessToken)(
      request(app.getHttpServer())
        .post('/whatsapp/webhooks')
        .send({ url: 'http://127.0.0.1:9/hook', events: ['message.received'] }),
    ).expect(201);
    const secretOnce = sub.body.data.secret as string;
    expect(typeof secretOnce).toBe('string');

    await authed(gym.accessToken)(
      request(app.getHttpServer()).post(
        `/whatsapp/webhooks/${sub.body.data.id}/test`,
      ),
    ).expect(201);

    const deliveries = await authed(gym.accessToken)(
      request(app.getHttpServer()).get('/whatsapp/webhooks/deliveries'),
    ).expect(200);
    expect(deliveries.body.data.length).toBeGreaterThanOrEqual(1);
    const row = deliveries.body.data[0] as Record<string, unknown>;
    expect(row.subscriptionId).toBe(sub.body.data.id);
    expect(row.event).toBe('test');
    expect(typeof row.status).toBe('string');
    expect(typeof row.attempts).toBe('number');
    expect(typeof row.createdAt).toBe('string');
    // Redaction: no secret, no payload, no signature, no headers.
    for (const forbidden of [
      'secret',
      'body',
      'payload',
      'signature',
      'headers',
      'requestBody',
    ]) {
      expect(row).not.toHaveProperty(forbidden);
    }
    const serialized = JSON.stringify(deliveries.body.data);
    expect(serialized).not.toContain(secretOnce);

    // Subscription listing never carries the secret either.
    const list = await authed(gym.accessToken)(
      request(app.getHttpServer()).get('/whatsapp/webhooks'),
    ).expect(200);
    expect(JSON.stringify(list.body.data)).not.toContain(secretOnce);

    // The other gym sees none of gym A's history.
    const foreign = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/whatsapp/webhooks/deliveries'),
    ).expect(200);
    expect(foreign.body.data).toEqual([]);

    // Oversized limit degrades to the cap.
    const capped = await authed(gym.accessToken)(
      request(app.getHttpServer()).get(
        '/whatsapp/webhooks/deliveries?limit=1000000',
      ),
    ).expect(200);
    expect(capped.body.data.length).toBeLessThanOrEqual(200);
  });
});
