import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** GET /roles and the assignment endpoints it exists to serve. */
describe('Roles (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let staffId: string;

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
    org = await registerOrg('Roles Test Gym');

    const invited = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `receptionist-${Date.now()}@example.com`,
          firstName: 'Reception',
          lastName: 'Staff',
          primaryBranchId: org.branchId,
          roleKey: 'RECEPTIONIST',
        }),
    ).expect(201);
    staffId = invited.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('lists the roles that can actually be handed out, with their grants', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/roles'),
    ).expect(200);

    const roles = res.body.data as Array<{
      key: string;
      name: string;
      permissions: string[];
    }>;
    expect(roles.length).toBeGreaterThan(0);

    const keys = roles.map((role) => role.key);
    expect(keys).toContain('ORG_OWNER');
    expect(keys).toContain('RECEPTIONIST');

    // Platform roles are seeded into the same global catalogue but are not
    // assignable inside an organization, so the list must not offer them.
    expect(keys).not.toContain('PLATFORM_OWNER');
    expect(keys).not.toContain('PLATFORM_ADMIN');

    const owner = roles.find((role) => role.key === 'ORG_OWNER')!;
    expect(owner.permissions.length).toBeGreaterThan(0);
    expect(owner.permissions).toContain('users.manage_roles');
  });

  it('publishes the permission catalogue behind those grants', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/roles/permissions'),
    ).expect(200);

    const permissions = res.body.data as Array<{
      key: string;
      description: string;
    }>;
    expect(permissions.some((p) => p.key === 'members.read')).toBe(true);
    expect(permissions.every((p) => p.description.length > 0)).toBe(true);

    // roles.manage named a capability nothing implements -- no endpoint
    // creates or edits a role -- so it is no longer advertised.
    expect(permissions.some((p) => p.key === 'roles.manage')).toBe(false);
    expect(permissions.some((p) => p.key === 'roles.read')).toBe(true);
  });

  it('assigns a role by key and revokes it by the grant id it returns', async () => {
    const assigned = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/users/${staffId}/roles`)
        .send({ roleKey: 'TRAINER' }),
    ).expect(201);

    const userRoleId = assigned.body.data.id;
    expect(userRoleId).toBeTruthy();

    const detail = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/users/${staffId}`),
    ).expect(200);
    const grantedKeys = (
      detail.body.data.userRoles as Array<{ role: { key: string } }>
    ).map((grant) => grant.role.key);
    expect(grantedKeys).toContain('TRAINER');

    await authed(org.accessToken)(
      request(app.getHttpServer()).delete(
        `/users/${staffId}/roles/${userRoleId}`,
      ),
    ).expect(200);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/users/${staffId}`),
    ).expect(200);
    const remaining = (
      after.body.data.userRoles as Array<{ role: { key: string } }>
    ).map((grant) => grant.role.key);
    expect(remaining).not.toContain('TRAINER');
  });

  it('refuses to grant a platform role inside an organization', async () => {
    // Platform routes are gated on User.platformRole, not on the grant, so
    // this would not confer platform access -- it would hand over every
    // ordinary permission under a name that claims far more.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/users/${staffId}/roles`)
        .send({ roleKey: 'PLATFORM_OWNER' }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/users/${staffId}/roles`)
        .send({ roleKey: 'PLATFORM_ADMIN' }),
    ).expect(400);
  });

  it('refuses an unknown role key', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/users/${staffId}/roles`)
        .send({ roleKey: 'SUPREME_LEADER' }),
    ).expect(400);
  });

  it('does not let one organization revoke another organization grant', async () => {
    const other = await registerOrg('Roles Isolation Gym');
    const assigned = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/users/${staffId}/roles`)
        .send({ roleKey: 'ACCOUNTANT' }),
    ).expect(201);

    await authed(other.accessToken)(
      request(app.getHttpServer()).delete(
        `/users/${staffId}/roles/${assigned.body.data.id}`,
      ),
    ).expect(404);
  });
});
