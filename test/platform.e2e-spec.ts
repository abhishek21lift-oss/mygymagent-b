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
  const ownerEmail = `platform-test-org-${Date.now()}@example.com`;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = new PrismaClient();

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Platform Test Gym',
        email: ownerEmail,
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
    if (app) {
      await app.close().catch(() => {});
    }
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

  it('tells the client who is platform staff, so the screens can exist at all', async () => {
    const platform = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    expect(platform.body.data.user.platformRole).toBe('PLATFORM_OWNER');

    // Platform routes are gated on this column rather than on an RBAC
    // grant, so it is the only thing that can tell a client whether to
    // offer the cross-tenant screens.
    const ordinary = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(200);
    expect(ordinary.body.data.user.platformRole).toBeNull();
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

  it("cuts a suspended gym's staff off: open sessions and new logins", async () => {
    // Suspended by the test above.
    await request(app.getHttpServer())
      .get('/members')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(401);
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ownerEmail, password: 'CorrectHorseBattery9' })
      .expect(401);
    expect(login.body.error.message).toMatch(/suspended/);

    // Platform staff belong to no gym and keep working.
    await request(app.getHttpServer())
      .get(`/platform/organizations/${org.organizationId}`)
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
  });

  it('lets them back in once the gym is reactivated', async () => {
    await request(app.getHttpServer())
      .patch(`/platform/organizations/${org.organizationId}/status`)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ status: 'ACTIVE' })
      .expect(200);
    await request(app.getHttpServer())
      .get('/members')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: ownerEmail, password: 'CorrectHorseBattery9' })
      .expect(201);
  });

  it('lists the active plan catalog to platform staff, and to nobody else', async () => {
    // Unauthenticated first: the guard refuses before the service runs.
    await request(app.getHttpServer())
      .get('/platform/organizations/plans')
      .expect(401);

    // An ordinary org owner -- even of a gym -- gets the platform 403.
    await request(app.getHttpServer())
      .get('/platform/organizations/plans')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .expect(403);

    const res = await request(app.getHttpServer())
      .get('/platform/organizations/plans')
      .set('Authorization', `Bearer ${platformToken}`)
      .expect(200);
    const keys = (res.body.data as Array<{ key: string }>).map((p) => p.key);
    // Migration-seeded catalog; the picker renders whatever this returns,
    // so a rename here must be a deliberate seed change, not drift.
    expect(keys).toEqual(['trial', 'starter', 'professional', 'business']);
  });

  it('lets a platform admin set the gym plan, and audits it against the target org', async () => {
    await request(app.getHttpServer())
      .patch(`/platform/organizations/${org.organizationId}/subscription`)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ planKey: 'starter', months: 3 })
      .expect(200)
      // The service returns the new subscription row itself (with planKey),
      // wrapped as `data` by the response interceptor -- there is no
      // `after` envelope on the wire.
      .expect((res) => {
        expect(res.body.data.planKey).toBe('starter');
      });

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: 'platform.set_organization_plan',
        resourceId: org.organizationId,
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(auditRow).not.toBeNull();
    expect(auditRow?.organizationId).toBe(org.organizationId);
  });

  it('refuses an unknown plan key instead of writing a dangling subscription', async () => {
    await request(app.getHttpServer())
      .patch(`/platform/organizations/${org.organizationId}/subscription`)
      .set('Authorization', `Bearer ${platformToken}`)
      .send({ planKey: 'no-such-plan', months: 1 })
      .expect(404);
  });
});
