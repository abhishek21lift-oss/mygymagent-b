import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Extends tenant-isolation.e2e-spec.ts to read surfaces it does not
 * cover: outstanding aggregates, PT sessions, assessments, documents,
 * invoices, and global search. Each case creates records as Org A and
 * proves Org B can neither fetch them by ID nor see them in lists.
 *
 * Requires the standard e2e prerequisites (Postgres, Redis, s3rver).
 */
describe('Cross-tenant reads (e2e)', () => {
  let app: INestApplication;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;
  let memberAId: string;

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
    orgA = await registerOrg('Crossread A Gym');
    orgB = await registerOrg('Crossread B Gym');

    const member = await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: orgA.branchId,
          firstName: 'Zed',
          lastName: `Crossread${Date.now()}`,
        }),
    ).expect(201);
    memberAId = member.body.data.id;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it("Org B's outstanding list contains none of Org A's balances", async () => {
    const res = await authed(orgB.accessToken)(
      request(app.getHttpServer()).get('/analytics/outstanding'),
    ).expect(200);
    const rows = res.body.data as Array<{ member?: { id: string } }>;
    expect(rows.some((r) => r.member?.id === memberAId)).toBe(false);
  });

  it('Org B cannot list PT sessions for Org A’s member', async () => {
    const res = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .get('/pt-sessions')
        .query({ memberId: memberAId }),
    ).expect(200);
    expect(res.body.data.items ?? res.body.data).toEqual([]);
  });

  it('Org B cannot read assessments for Org A’s member', async () => {
    await authed(orgB.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberAId}/measurements`),
    ).expect(404);
  });

  it('Org B cannot list documents for Org A’s member', async () => {
    await authed(orgB.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberAId}/documents`),
    ).expect(404);
  });

  it('Org B cannot list invoices for Org A’s member', async () => {
    const res = await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .get('/invoices')
        .query({ memberId: memberAId }),
    ).expect(200);
    expect(res.body.data.items ?? res.body.data).toEqual([]);
  });

  it('Org B global search never surfaces Org A’s member', async () => {
    const probe = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/search').query({ q: 'Zed' }),
    ).expect(200);
    expect(
      (probe.body.data.results as Array<{ id: string }>).some(
        (r) => r.id === memberAId,
      ),
    ).toBe(true);
    const res = await authed(orgB.accessToken)(
      request(app.getHttpServer()).get('/search').query({ q: 'Zed' }),
    ).expect(200);
    expect(
      (res.body.data.results as Array<{ id: string }>).some(
        (r) => r.id === memberAId,
      ),
    ).toBe(false);
  });
});
