import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

/**
 * The throttler is configured (global 120/min + tighter per-endpoint limits
 * on the auth-abuse-prone routes -- see docs/security/overview.md) but,
 * until now, nothing actually asserted a 429 comes back once a limit is
 * exceeded. Each `it` here gets a fresh app (hence a fresh in-memory
 * throttler store) so the two limits can't bleed into each other or into
 * whatever the rest of the suite has already sent from the same IP.
 */
describe('Rate limiting (e2e)', () => {
  async function freshApp(): Promise<INestApplication> {
    return createTestApp();
  }

  it('returns 429 once /auth/register is called more than 5 times in a minute', async () => {
    const app = await freshApp();
    try {
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
    } finally {
      await app.close();
    }
  });

  it('returns 429 once /auth/forgot-password is called more than 5 times in a minute', async () => {
    const app = await freshApp();
    try {
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
    } finally {
      await app.close();
    }
  });

  it("the global 120/min limit doesn't interfere with routes well under it", async () => {
    const app = await freshApp();
    try {
      // /health has no per-route @Throttle, so it rides the global limit;
      // a handful of calls should never be enough to trip 120/min.
      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer()).get('/health').expect(200);
      }
    } finally {
      await app.close();
    }
  });
});
