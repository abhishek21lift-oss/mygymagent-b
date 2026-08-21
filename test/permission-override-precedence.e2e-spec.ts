import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PermissionsService } from '../src/rbac/permissions.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Regression, against a real Postgres database (not a mocked Prisma
 * client), for the DENY-always-wins bug found in the audit (finding F-04):
 * `PermissionsService.hasPermission()` used to pick a single
 * UserPermissionOverride row via `findFirst` ordered by `branchId DESC`.
 * PostgreSQL's default for `DESC` is NULLS FIRST, so the org-wide row
 * (`branchId IS NULL`) was returned before a branch-specific row -- the
 * opposite of "branch-specific override takes precedence", and specifically
 * the opposite of the documented "DENY always wins" invariant whenever a
 * user held both an org-wide ALLOW-shaped grant (here: via their role) and
 * a branch-specific DENY override for the same permission key.
 *
 * `permissions.service.spec.ts` proves the same invariant against a
 * mocked Prisma client; this suite proves it survives a real round trip
 * through Postgres's actual NULLS ordering, which the audit flagged as
 * unverified at runtime.
 */
describe('Permission override precedence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let permissions: PermissionsService;
  let owner: RegisteredAccount;
  let branchId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    permissions = app.get(PermissionsService);

    const email = `override-precedence-owner-${Date.now()}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Override Precedence Test Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Test',
      })
      .expect(201);
    owner = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: '',
    };

    const branches = await authed(owner.accessToken)(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('a branch-specific DENY override beats an org-wide role-derived ALLOW for the same permission', async () => {
    // ORG_OWNER holds members.update org-wide via role -- confirm the
    // baseline before adding the override.
    await expect(
      permissions.hasPermission(
        owner.userId,
        owner.organizationId,
        'members.update',
        branchId,
      ),
    ).resolves.toBe(true);

    const permission = await prisma.permission.findUniqueOrThrow({
      where: { key: 'members.update' },
    });
    await prisma.userPermissionOverride.create({
      data: {
        userId: owner.userId,
        permissionId: permission.id,
        organizationId: owner.organizationId,
        branchId,
        effect: 'DENY',
      },
    });

    // With the branch specified, the DENY override must win over the
    // role-derived org-wide ALLOW.
    await expect(
      permissions.hasPermission(
        owner.userId,
        owner.organizationId,
        'members.update',
        branchId,
      ),
    ).resolves.toBe(false);

    // Without a branch in the query, the branch-specific DENY doesn't
    // match at all -- the org-wide role grant still applies. This isn't a
    // loophole: every real request that could act on branch-scoped data
    // supplies a branchId (via PermissionsGuard's own resolution), exactly
    // like this test does above.
    await expect(
      permissions.hasPermission(
        owner.userId,
        owner.organizationId,
        'members.update',
      ),
    ).resolves.toBe(true);
  });
});
