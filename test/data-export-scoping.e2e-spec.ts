import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * D-SEC01 (F-SEC01): GET /data/members/export honors the enforced
 * branch scope. An org-wide data.export holder receives every member;
 * a branch-scoped holder receives only their own branch even when the
 * x-branch-id hint names another branch; another organization's members
 * never appear.
 *
 * Requires the standard e2e prerequisites (Postgres via .env.test, Redis,
 * s3rver). BLOCKED locally until the test database is reachable; runs in CI.
 */
describe('Member export branch scoping (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokensService;
  let owner: RegisteredAccount;
  let branchA: string;
  let branchB: string;
  let exporterToken: string;

  const authed = (token: string, branchId?: string) => (req: request.Test) => {
    req.set('Authorization', `Bearer ${token}`);
    if (branchId) req.set('x-branch-id', branchId);
    return req;
  };

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    tokens = app.get(TokensService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Export Scope Gym',
        email: `export-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Export',
      })
      .expect(201);
    owner = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: '',
    };
    const asOwner = (req: request.Test) => authed(owner.accessToken)(req);

    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchA = branches.body.data.items[0].id;
    const branchBRes = await asOwner(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'Branch B', slug: 'branch-b' }),
    ).expect(201);
    branchB = branchBRes.body.data.id;

    const tag = Date.now().toString().slice(-6);
    await asOwner(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchA,
          firstName: 'Export',
          lastName: `Alpha${tag}`,
        }),
    ).expect(201);
    await asOwner(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchB,
          firstName: 'Export',
          lastName: `Beta${tag}`,
        }),
    ).expect(201);

    // Branch-scoped exporter: custom role holding data.export, granted
    // on Branch A only (no HTTP endpoint creates org roles; fixture goes
    // through Prisma like branch-scoping.e2e-spec.ts).
    const invited = await asOwner(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `branch-exporter-${Date.now()}@example.com`,
          firstName: 'Branch',
          lastName: 'Exporter',
          primaryBranchId: branchA,
          roleKey: 'BRANCH_MANAGER',
          roleBranchId: branchA,
        }),
    ).expect(201);
    const exporterId = invited.body.data.id;
    await prisma.user.update({
      where: { id: exporterId },
      data: { status: 'ACTIVE' },
    });
    const perms = await prisma.permission.findMany({
      where: { key: { in: ['data.export', 'members.read'] } },
    });
    expect(perms).toHaveLength(2);
    const role = await prisma.role.create({
      data: {
        organizationId: owner.organizationId,
        key: 'BRANCH_EXPORTER_TEST',
        name: 'Branch Exporter (test fixture)',
        rolePermissions: {
          create: perms.map((p) => ({ permissionId: p.id })),
        },
      },
    });
    await prisma.userRole.create({
      data: {
        userId: exporterId,
        roleId: role.id,
        organizationId: owner.organizationId,
        branchId: branchA,
      },
    });
    exporterToken = tokens.signAccessToken(exporterId);

    (globalThis as any).__exportTag = tag;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  const tag = () => (globalThis as any).__exportTag as string;

  it('exports every member for an org-wide holder', async () => {
    const res = await authed(owner.accessToken)(
      request(app.getHttpServer()).get('/data/members/export'),
    ).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text).toContain(`Alpha${tag()}`);
    expect(res.text).toContain(`Beta${tag()}`);
  });

  it('exports only the enforced branch for a branch-scoped holder', async () => {
    const res = await authed(
      exporterToken,
      branchA,
    )(request(app.getHttpServer()).get('/data/members/export')).expect(200);
    expect(res.text).toContain(`Alpha${tag()}`);
    expect(res.text).not.toContain(`Beta${tag()}`);
  });

  it('ignores a tampered branch hint naming another branch', async () => {
    const res = await authed(
      exporterToken,
      branchB,
    )(request(app.getHttpServer()).get('/data/members/export'));
    if (res.status === 200) {
      expect(res.text).toContain(`Alpha${tag()}`);
      expect(res.text).not.toContain(`Beta${tag()}`);
    } else {
      expect(res.status).toBe(403);
    }
  });

  it('never includes another organization member', async () => {
    const res2 = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Export Other Gym',
        email: `export-other-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Other',
      })
      .expect(201);
    const otherToken = res2.body.data.accessToken;
    const otherBranches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${otherToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/members')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        primaryBranchId: otherBranches.body.data.items[0].id,
        firstName: 'Export',
        lastName: `Gamma${tag()}`,
      })
      .expect(201);

    const res = await authed(owner.accessToken)(
      request(app.getHttpServer()).get('/data/members/export'),
    ).expect(200);
    expect(res.text).not.toContain(`Gamma${tag()}`);
  });
});
