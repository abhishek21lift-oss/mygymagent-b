import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Who can change a gym's SaaS plan, and the global search's view of
 * deleted members.
 *
 * The plan endpoint used to let any gym owner move their own organization
 * onto any plan -- the Billing page's "Choose plan" handed out the top tier
 * with no payment behind it. Plans are now set by platform staff only.
 */
describe('Platform billing and search (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let org: RegisteredAccount;
  let platformToken: string;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      request(server()).delete(url).set('Authorization', `Bearer ${token}`),
  });

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = new PrismaClient();
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Billing Lock Gym',
        email: `billing-lock-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const branches = await as(res.body.data.accessToken)
      .get('/branches')
      .expect(200);
    org = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };

    const platformEmail = `billing-platform-${suffix}@example.com`;
    await prisma.user.create({
      data: {
        organizationId: null,
        platformRole: 'PLATFORM_OWNER',
        email: platformEmail,
        passwordHash: await argon2.hash('CorrectHorseBattery9'),
        firstName: 'Platform',
        lastName: 'Owner',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const login = await request(server())
      .post('/auth/login')
      .send({ email: platformEmail, password: 'CorrectHorseBattery9' })
      .expect(201);
    platformToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app?.close().catch(() => {});
  });

  describe('plan changes', () => {
    it('refuses a gym owner changing their own plan, and changes nothing', async () => {
      const before = await as(org.accessToken)
        .get('/platform-billing/subscription')
        .expect(200);

      const res = await as(org.accessToken)
        .post('/platform-billing/subscription')
        .send({ planKey: 'business' })
        .expect(403);
      expect(res.body.error.message).toMatch(/contact support/i);

      const after = await as(org.accessToken)
        .get('/platform-billing/subscription')
        .expect(200);
      expect(after.body.data).toEqual(before.body.data);
    });

    it('refuses a gym owner using the platform route for their own gym', async () => {
      await as(org.accessToken)
        .patch(`/platform/organizations/${org.organizationId}/subscription`)
        .send({ planKey: 'business' })
        .expect(403);
    });

    it('lets platform staff set a plan for a number of months, and records who did it', async () => {
      const res = await as(platformToken)
        .patch(`/platform/organizations/${org.organizationId}/subscription`)
        .send({ planKey: 'starter', months: 3 })
        .expect(200);
      expect(res.body.data.planKey).toBe('starter');

      const sub = await as(org.accessToken)
        .get('/platform-billing/subscription')
        .expect(200);
      expect(sub.body.data.planKey).toBe('starter');
      expect(sub.body.data.status).toBe('ACTIVE');
      const days =
        (new Date(sub.body.data.currentPeriodEnd).getTime() -
          new Date(sub.body.data.currentPeriodStart).getTime()) /
        86_400_000;
      expect(days).toBeGreaterThanOrEqual(89);
      expect(days).toBeLessThanOrEqual(92);

      const audit = await prisma.auditLog.findFirst({
        where: {
          organizationId: org.organizationId,
          action: 'platform.set_organization_plan',
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit?.afterState).toMatchObject({ planKey: 'starter' });
    });

    it('rejects an unknown plan, an out-of-range period and an unknown organization', async () => {
      await as(platformToken)
        .patch(`/platform/organizations/${org.organizationId}/subscription`)
        .send({ planKey: 'no-such-plan' })
        .expect(404);
      await as(platformToken)
        .patch(`/platform/organizations/${org.organizationId}/subscription`)
        .send({ planKey: 'starter', months: 0 })
        .expect(400);
      await as(platformToken)
        .patch(
          '/platform/organizations/00000000-0000-0000-0000-000000000000/subscription',
        )
        .send({ planKey: 'starter' })
        .expect(404);
    });
  });

  describe('search', () => {
    it('stops finding a member once they are deleted', async () => {
      const name = `Zyxwv${Math.random().toString(36).slice(2, 7)}`;
      const created = await as(org.accessToken)
        .post('/members')
        .send({
          primaryBranchId: org.branchId,
          firstName: name,
          lastName: 'Searchable',
        })
        .expect(201);
      const memberId = created.body.data.id;

      const found = await as(org.accessToken)
        .get(`/search?q=${name}`)
        .expect(200);
      expect(
        found.body.data.results.map((r: { id: string }) => r.id),
      ).toContain(memberId);

      await as(org.accessToken).delete(`/members/${memberId}`).expect(200);

      const gone = await as(org.accessToken)
        .get(`/search?q=${name}`)
        .expect(200);
      expect(
        gone.body.data.results.map((r: { id: string }) => r.id),
      ).not.toContain(memberId);
    });
  });
});
