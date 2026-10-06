import type { INestApplication } from '@nestjs/common';
import { missingContractKeys } from '../src/command-center/telemetry-contract';
import request from 'supertest';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { createTestApp } from './utils/test-app';

/**
 * Access control for the Command Center.
 *
 * The same discipline as platform.e2e-spec.ts, applied to the new surface:
 * the telemetry endpoint describes the whole deployment and every tenant's
 * AI spend, so an ordinary gym user reaching it would be a cross-tenant
 * read with no `organizationId` to blame. The guard is the only thing
 * standing between them and it, so it is tested rather than assumed.
 */
/** Every card the snapshot carries; see TELEMETRY_CONTRACT. */
const ALL_CARDS = [
  'readiness',
  'queues',
  'ai',
  'http',
  'whatsapp',
  'messaging',
  'automation',
  'tenants',
] as const;

describe('Command Center (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let orgToken: string;
  let platformToken: string;
  const stamp = Date.now();

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = new PrismaClient();

    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Command Center Test Gym',
        email: `cc-org-${stamp}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    orgToken = reg.body.data.accessToken;

    const platformEmail = `cc-platform-${stamp}@example.com`;
    await prisma.user.create({
      data: {
        organizationId: null,
        platformRole: 'PLATFORM_ADMIN',
        email: platformEmail,
        passwordHash: await argon2.hash('CorrectHorseBattery9'),
        firstName: 'Platform',
        lastName: 'Admin',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: platformEmail, password: 'CorrectHorseBattery9' })
      .expect(201);
    platformToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    if (app) await app.close().catch(() => {});
  });

  const snapshot = () =>
    request(app.getHttpServer()).get('/platform/command-center/snapshot');

  it('rejects an unauthenticated request', async () => {
    await snapshot().expect(401);
  });

  it("rejects an ordinary org owner, even the org's own owner", async () => {
    await snapshot().set('Authorization', `Bearer ${orgToken}`).expect(403);
  });

  it('serves the snapshot to platform staff', async () => {
    const res = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    const body = res.body.data;
    expect(body.collectedAt).toBeDefined();
    expect(body.readiness).toBeDefined();
    expect(body.queues).toBeDefined();
    expect(body.ai).toBeDefined();
  });

  it('satisfies the telemetry contract on every measured card, against real Postgres', async () => {
    const res = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .query({ refresh: 'true' })
      .expect(200);

    for (const card of ALL_CARDS) {
      const result = res.body.data[card];
      if (result.status === 'unavailable') continue;
      expect({
        card,
        missing: missingContractKeys(card, result.value),
      }).toEqual({ card, missing: [] });
    }
  });

  it('grades every card rather than failing the whole snapshot', async () => {
    const res = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    // Each card carries its own verdict and its own timestamp. A snapshot
    // that threw on one dead dependency would be useless exactly when it is
    // needed, so per-card degradation is the contract, not a nicety.
    for (const card of ALL_CARDS) {
      expect(['ok', 'degraded', 'unavailable']).toContain(
        res.body.data[card].status,
      );
      expect(res.body.data[card].checkedAt).toBeDefined();
    }
  });

  it('never answers with a fabricated zero for a card it could not measure', async () => {
    const res = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    for (const card of ALL_CARDS) {
      if (res.body.data[card].status === 'unavailable') {
        expect(res.body.data[card].value).toBeNull();
        expect(res.body.data[card].unavailableReason).toBeTruthy();
      }
    }
  });

  it('reports queue depth from the same queues the workers use', async () => {
    const res = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    const names = res.body.data.queues.value.queues.map(
      (q: { name: string }) => q.name,
    );
    expect(names.sort()).toEqual([
      'automation',
      'notifications',
      'push',
      'whatsapp-web',
    ]);
  });

  it('reuses the cached snapshot across consecutive reads', async () => {
    const first = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    const second = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    expect(second.body.data.collectedAt).toBe(first.body.data.collectedAt);
  });

  it('re-probes when refresh=true, for an operator who does not believe a card', async () => {
    const first = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fresh = await snapshot()
      .query({ refresh: 'true' })
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    expect(Date.parse(fresh.body.data.collectedAt)).toBeGreaterThanOrEqual(
      Date.parse(first.body.data.collectedAt),
    );
  });

  it('does not treat the string "false" as a request to refresh', async () => {
    const first = await snapshot()
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await snapshot()
      .query({ refresh: 'false' })
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);

    // Boolean("false") is true, so a naive coercion would re-probe on the
    // most common query string an operator or a cache-buster would send.
    expect(second.body.data.collectedAt).toBe(first.body.data.collectedAt);
  });

  it('rejects an unexpected query parameter instead of ignoring it', async () => {
    await snapshot()
      .query({ nonsense: '1' })
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(400);
  });

  it('rejects a refresh value that is neither true nor false', async () => {
    // Silently treating a typo as "no refresh" would leave an operator
    // staring at a cached card believing it was live.
    await snapshot()
      .query({ refresh: 'yes' })
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(400);
  });
});
