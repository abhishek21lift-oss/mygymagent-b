import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * D-DB02 (F-DB02): same-organization duplicate identities fail
 * deterministically with 409 CONFLICT; cross-organization reuse and
 * blank contacts stay legal.
 *
 * Requires the standard e2e prerequisites (Postgres via .env.test, Redis,
 * s3rver). BLOCKED locally until the test database is reachable; runs in CI.
 *
 * The parallel-duplicate case is intentionally skipped: closing the
 * check-then-act race needs the partial unique indexes (D-DB02 step 3),
 * which land only after the duplicate triage they require. Un-skip it
 * together with that migration.
 */
describe('Member contact conflicts (e2e)', () => {
  let app: INestApplication;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

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

  const suffix = () => Date.now().toString().slice(-6);

  function createMember(org: RegisteredAccount, email: string, phone: string) {
    return authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: org.branchId,
          firstName: 'Conflict',
          lastName: `Case${suffix()}${Math.random().toString(36).slice(2, 5)}`,
          email,
          phone,
        }),
    );
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    orgA = await registerOrg('Conflict A Gym');
    orgB = await registerOrg('Conflict B Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('rejects a duplicate email regardless of case', async () => {
    const email = `DUPE-${suffix()}@example.com`;
    await createMember(orgA, email, `900000${suffix()}`.slice(0, 10)).expect(
      201,
    );
    const res = await createMember(
      orgA,
      email.toLowerCase(),
      `911111${suffix()}`.slice(0, 10),
    ).expect(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a duplicate phone despite different formatting', async () => {
    const phone = `922222${suffix()}`.slice(0, 10);
    await createMember(orgA, `fmt-${suffix()}@example.com`, phone).expect(201);
    await createMember(
      orgA,
      `fmt2-${suffix()}@example.com`,
      `+91 ${phone.slice(0, 5)} ${phone.slice(5)}`,
    ).expect(409);
  });

  it('rejects taking over a sibling member email on update', async () => {
    const first = await createMember(
      orgA,
      `takeover-${suffix()}@example.com`,
      `933333${suffix()}`.slice(0, 10),
    ).expect(201);
    const second = await createMember(
      orgA,
      `victim-${suffix()}@example.com`,
      `944444${suffix()}`.slice(0, 10),
    ).expect(201);
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .patch(`/members/${second.body.data.id}`)
        .send({ email: first.body.data.email }),
    ).expect(409);
  });

  it('allows the same contact in another organization', async () => {
    const email = `shared-${suffix()}@example.com`;
    const phone = `955555${suffix()}`.slice(0, 10);
    await createMember(orgA, email, phone).expect(201);
    await createMember(orgB, email, phone).expect(201);
  });

  it('allows blank contacts', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: orgA.branchId,
          firstName: 'NoContact',
          lastName: `Blank${suffix()}`,
        }),
    ).expect(201);
  });

  it.skip('parallel duplicate creates admit exactly one winner', async () => {
    // Requires the D-DB02 partial unique indexes (deferred until the
    // duplicate triage in scripts/member-contact-triage.sql is resolved).
    const email = `race-${suffix()}@example.com`;
    const phone = `966666${suffix()}`.slice(0, 10);
    const attempts = await Promise.allSettled(
      Array.from({ length: 5 }, () => createMember(orgA, email, phone)),
    );
    const created = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.status === 201,
    );
    const conflicted = attempts.filter(
      (a) => a.status === 'fulfilled' && a.value.status === 409,
    );
    expect(created).toHaveLength(1);
    expect(conflicted).toHaveLength(4);
  });
});
