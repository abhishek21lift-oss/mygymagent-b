import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** GET /audit-logs -- the read side of a trail that was write-only. */
describe('Audit log (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;

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
    org = await registerOrg('Audit Test Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('records a member creation and serves it back with who did it', async () => {
    const member = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Audited',
        lastName: 'Member',
      }),
    ).expect(201);

    const logs = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/audit-logs')
        .query({ resource: 'member' }),
    ).expect(200);

    const entry = (
      logs.body.data.items as Array<{
        action: string;
        resource: string;
        resourceId: string | null;
        actorUserId: string | null;
        actorName: string | null;
        createdAt: string;
      }>
    ).find((row) => row.resourceId === member.body.data.id);

    expect(entry).toBeDefined();
    expect(entry!.action).toBe('create');
    expect(entry!.resource).toBe('member');
    // The whole point of the trail: a name, not just an id.
    expect(entry!.actorUserId).toBe(org.userId);
    expect(entry!.actorName!.length).toBeGreaterThan(0);
  });

  it('leaves the before/after snapshots out unless they are asked for', async () => {
    const lean = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/audit-logs').query({ pageSize: 1 }),
    ).expect(200);
    expect(lean.body.data.items[0]).not.toHaveProperty('afterState');

    const full = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/audit-logs')
        .query({ pageSize: 1, withState: 'true' }),
    ).expect(200);
    expect(full.body.data.items[0]).toHaveProperty('afterState');
  });

  it('never puts a password hash in a snapshot', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `audited-staff-${Date.now()}@example.com`,
          firstName: 'Audited',
          lastName: 'Staff',
          primaryBranchId: org.branchId,
          roleKey: 'RECEPTIONIST',
        }),
    ).expect(201);

    const logs = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/audit-logs')
        .query({ resource: 'user', withState: 'true' }),
    ).expect(200);

    const serialised = JSON.stringify(logs.body.data.items);
    expect(serialised).not.toContain('passwordHash');
  });

  it('filters by action, and reports the resources and actions present', async () => {
    const filtered = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/audit-logs')
        .query({ action: 'create' }),
    ).expect(200);
    expect(
      (filtered.body.data.items as Array<{ action: string }>).every(
        (row) => row.action === 'create',
      ),
    ).toBe(true);

    const facets = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/audit-logs/facets'),
    ).expect(200);
    const resources = (
      facets.body.data.resources as Array<{ value: string; count: number }>
    ).map((row) => row.value);
    expect(resources).toContain('member');
    expect(resources).toContain('user');
  });

  it('comes back newest first', async () => {
    const logs = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/audit-logs').query({ pageSize: 10 }),
    ).expect(200);
    const times = (logs.body.data.items as Array<{ createdAt: string }>).map(
      (row) => Date.parse(row.createdAt),
    );
    const sorted = [...times].sort((a, b) => b - a);
    expect(times).toEqual(sorted);
  });

  it('never serves one organization another organization trail', async () => {
    const other = await registerOrg('Audit Isolation Gym');
    await authed(other.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: other.branchId,
        firstName: 'Theirs',
        lastName: 'Only',
      }),
    ).expect(201);

    const ours = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/audit-logs')
        .query({ pageSize: 100, withState: 'true' }),
    ).expect(200);

    expect(JSON.stringify(ours.body.data.items)).not.toContain('Theirs');
  });

  it('refuses a caller without audit.read', async () => {
    const invited = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `no-audit-${Date.now()}@example.com`,
          firstName: 'No',
          lastName: 'Audit',
          primaryBranchId: org.branchId,
          roleKey: 'RECEPTIONIST',
        }),
    ).expect(201);
    expect(invited.body.data.id).toBeTruthy();

    // A receptionist has no audit.read; proven through the catalogue rather
    // than by signing in, since an invited account has no password yet.
    const roles = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/roles'),
    ).expect(200);
    const receptionist = (
      roles.body.data as Array<{ key: string; permissions: string[] }>
    ).find((role) => role.key === 'RECEPTIONIST');
    expect(receptionist!.permissions).not.toContain('audit.read');
  });
});
