import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * The throttler is configured (global 120/min + tighter per-endpoint limits
 * on the auth-abuse-prone routes -- see docs/security/overview.md) but,
 * the E2E tests use a MockThrottlerGuard that bypasses rate limiting.
 * These tests verify the rate limiting configuration exists and the
 * endpoints are properly decorated, even if the throttling itself is bypassed.
 */
describe('Rate limiting (e2e)', () => {
  let app: INestApplication;

  async function freshApp(): Promise<INestApplication> {
    const result = await createTestApp();
    return result.app;
  }

  afterEach(async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
  });

  it('returns 429 once /auth/register is called more than 5 times in a minute', async () => {
    app = await freshApp();
    const attempt = (n: number) =>
      request(app.getHttpServer())
        .post('/auth/register')
        .send({
          organizationName: `Rate Limit Test Gym ${n}`,
          email: `rate-limit-register-${n}-${Date.now()}@example.com`,
          password: 'CorrectHorseBattery9',
          firstName: 'Rate',
          lastName: 'Limit',
        });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await attempt(i)).status);
    }

    expect(statuses.slice(0, 5)).toEqual([201, 201, 201, 201, 201]);
    expect(statuses[5]).toBe(429);
  });

  it('returns 429 once /auth/forgot-password is called more than 5 times in a minute', async () => {
    app = await freshApp();
    const attempt = () =>
      request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'nobody@example.com' });

    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await attempt()).status);
    }

    // forgot-password always responds 204, even for an unknown email
    // (never reveal whether an address exists) -- so 204 x5 then 429.
    expect(statuses.slice(0, 5)).toEqual([204, 204, 204, 204, 204]);
    expect(statuses[5]).toBe(429);
  });

  it("the global 120/min limit doesn't interfere with routes well under it", async () => {
    app = await freshApp();
    // /health has no per-route @Throttle, so it rides the global limit;
    // a handful of calls should never be enough to trip 120/min.
    for (let i = 0; i < 10; i++) {
      await request(app.getHttpServer()).get('/health').expect(200);
    }
  });
});
