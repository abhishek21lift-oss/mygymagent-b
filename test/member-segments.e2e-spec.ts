import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** GET/POST /members/segments and the members a segment resolves to --
 * the saved-search surface behind the member-intelligence screens. */
describe('Member segments (e2e)', () => {
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
    org = await registerOrg('Segments Test Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('seeds the system segments on first listing, each with a member count', async () => {
    const list = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/members/segments'),
    ).expect(200);

    const rows = list.body.data as Array<{
      segment: { name: string; isSystem: boolean };
      memberCount: number;
    }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => typeof row.memberCount === 'number')).toBe(true);

    const names = rows.map((row) => row.segment.name);
    expect(names).toContain('At Risk');
    expect(names).toContain('New Members');
  });

  it('publishes the field catalogue the rule builder is limited to', async () => {
    const fields = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/members/segments/fields'),
    ).expect(200);

    const names = (fields.body.data as Array<{ name: string }>).map(
      (field) => field.name,
    );
    expect(names).toContain('status');
    expect(names).toContain('daysSinceJoining');
  });

  it('saves a segment and resolves it to the members that match', async () => {
    const matching = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Segment',
        lastName: 'Match',
      }),
    ).expect(201);

    const created = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({
          name: 'Joined this week',
          description: 'Signed up in the last seven days',
          rules: [{ field: 'daysSinceJoining', operator: 'lte', value: 7 }],
        }),
    ).expect(201);
    const segmentId = created.body.data.id;
    // A posted segment is never a system segment, whatever it asks for.
    expect(created.body.data.isSystem).toBe(false);

    const detail = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/members/segments/${segmentId}`),
    ).expect(200);
    expect(detail.body.data.segment.name).toBe('Joined this week');
    expect(detail.body.data.memberCount).toBeGreaterThanOrEqual(1);

    const members = await authed(org.accessToken)(
      request(app.getHttpServer()).get(
        `/members/segments/${segmentId}/members`,
      ),
    ).expect(200);
    const ids = (members.body.data.members as Array<{ memberId: string }>).map(
      (row) => row.memberId,
    );
    expect(ids).toContain(matching.body.data.id);
    expect(members.body.data.totalCount).toBeGreaterThanOrEqual(1);
  });

  it('refuses a segment whose rules are not rules', async () => {
    // Each of these used to reach evaluateRules and answer 500.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({ name: 'Null rules', rules: null }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({ name: 'String rules', rules: 'everyone' }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({ name: 'No name at all', rules: [] })
        .send({ name: '' }),
    ).expect(400);
  });

  it('refuses a rule naming a field the evaluator does not know', async () => {
    // Left unchecked this saves cleanly and then matches nobody, which
    // reads as "the segment is empty" rather than "the rule is wrong".
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({
          name: 'Typo segment',
          rules: [{ field: 'daysSinceJoinin', operator: 'lte', value: 7 }],
        }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({
          name: 'Bad operator',
          rules: [{ field: 'status', operator: 'matches', value: 'ACTIVE' }],
        }),
    ).expect(400);
  });

  it('refuses a non-numeric page size instead of passing NaN to the query', async () => {
    const created = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({
          name: 'Paged segment',
          rules: [{ field: 'daysSinceJoining', operator: 'gte', value: 0 }],
        }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .get(`/members/segments/${created.body.data.id}/members`)
        .query({ limit: 'abc' }),
    ).expect(400);

    const paged = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get(`/members/segments/${created.body.data.id}/members`)
        .query({ limit: 1, offset: 0 }),
    ).expect(200);
    expect(paged.body.data.members.length).toBeLessThanOrEqual(1);
  });

  it('will not edit or delete a system segment', async () => {
    const list = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/members/segments'),
    ).expect(200);
    const system = (
      list.body.data as Array<{ segment: { id: string; isSystem: boolean } }>
    ).find((row) => row.segment.isSystem);
    expect(system).toBeDefined();

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/members/segments/${system!.segment.id}`)
        .send({ name: 'Renamed' }),
    ).expect(403);
  });

  it('does not serve one organization another organization segment', async () => {
    const other = await registerOrg('Segments Isolation Gym');
    const theirs = await authed(other.accessToken)(
      request(app.getHttpServer())
        .post('/members/segments')
        .send({
          name: 'Theirs',
          rules: [{ field: 'status', operator: 'eq', value: 'ACTIVE' }],
        }),
    ).expect(201);

    const detail = await authed(org.accessToken)(
      request(app.getHttpServer()).get(
        `/members/segments/${theirs.body.data.id}`,
      ),
    ).expect(200);
    expect(detail.body.data).toBeNull();

    await authed(org.accessToken)(
      request(app.getHttpServer()).get(
        `/members/segments/${theirs.body.data.id}/members`,
      ),
    ).expect(404);
  });
});
