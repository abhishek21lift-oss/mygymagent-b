import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import * as argon2 from 'argon2';
import { PrismaClient } from '@prisma/client';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Access-control test for the platform-admin surface: ordinary org users
 * must never reach /platform/*, regardless of their org-level permissions,
 * and a platform admin's actions must be attributed to the *target*
 * organization in the audit log, not to their own (null) organizationId.
 */
describe('Platform administration (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let org: RegisteredAccount;
  let platformToken: string;
  const platformEmail = `platform-admin-${Date.now()}@example.com`;
  const platformPassword = 'CorrectHorseBattery9';

  beforeAll(async () => {
    app = await createTestApp();
    prisma = new PrismaClient();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Platform Test Gym',
        email: `platform-test-org-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    org = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: '',
    };

    await prisma.user.create({
      data: {
        organizationId: null,
        platformRole: 'PLATFORM_OWNER',
        email: platformEmail,
        passwordHash: await argon2.hash(platformPassword),
        firstName: 'Platform',
        lastName: 'Owner',
        status: 'ACTIVE',
        emailVerifiedAt: new Date(),
      },
    });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: platformEmail, password: platformPassword })
      .expect(201);
    platformToken = login.body.data.accessToken;
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await app.close();
  });

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .get('/platform/organizations')
      .expect(401);
  });

  it("rejects an ordinary org user, even the org's own owner", async () => {
    await request(app.getHttpServer())
      .get('/platform/organizations')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(403);
  });

  it('lets a platform admin list organizations across every tenant', async () => {
    const res = await request(app.getHttpServer())
      .get('/platform/organizations')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(
      res.body.data.items.some(
        (o: { id: string }) => o.id === org.organizationId,
      ),
    ).toBe(true);
  });

  it('lets a platform admin read a single organization by id', async () => {
    const res = await request(app.getHttpServer())
      .get(`/platform/organizations/${org.organizationId}`)
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(res.body.data.id).toBe(org.organizationId);
  });

  it("still rejects an ordinary org user reading another org's detail", async () => {
    await request(app.getHttpServer())
      .get(`/platform/organizations/${org.organizationId}`)
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(403);
  });

  it('lets a platform admin suspend an organization, and records the audit entry against the target org, not null', async () => {
    await request(app.getHttpServer())
      .patch(`/platform/organizations/${org.organizationId}/status`)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ status: 'SUSPENDED' })
      .expect(200)
      .expect((res) => {
        expect(res.body.data.status).toBe('SUSPENDED');
      });

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: 'platform.update_organization_status',
        resourceId: org.organizationId,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.organizationId).toBe(org.organizationId);
  });
});
