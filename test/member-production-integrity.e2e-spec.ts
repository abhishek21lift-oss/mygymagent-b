import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Member OS production integrity (e2e)', () => {
  let app: INestApplication;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;
  let memberA: string;
  let memberB: string;
  let tagA: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
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
    const branches = await authed(res.body.data.accessToken)(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    orgA = await registerOrg('Member Integrity A');
    orgB = await registerOrg('Member Integrity B');

    const createdA = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgA.branchId,
        firstName: 'Integrity',
        lastName: 'A',
      }),
    ).expect(201);
    memberA = createdA.body.data.id;

    const createdB = await authed(orgB.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: orgB.branchId,
        firstName: 'Integrity',
        lastName: 'B',
      }),
    ).expect(201);
    memberB = createdB.body.data.id;

    const tag = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/members/tags').send({ name: 'VIP' }),
    ).expect(201);
    tagA = tag.body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it('bulk status changes are recorded in the member status timeline', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/status')
        .send({ memberIds: [memberA], status: 'INACTIVE' }),
    ).expect(200);

    const history = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberA}/status-history`),
    ).expect(200);

    expect(
      history.body.data.some(
        (entry: { fromStatus: string; toStatus: string }) =>
          entry.fromStatus === 'ACTIVE' && entry.toStatus === 'INACTIVE',
      ),
    ).toBe(true);
  });

  it('bulk tag assignment rejects a foreign-tenant tag without changing assignments', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post(`/members/${memberA}/tags`)
        .send({ tagIds: [] }),
    ).expect(200);

    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/tags')
        .send({ memberIds: [memberA], tagIds: [tagA] }),
    ).expect(200);

    const before = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberA}/tags`),
    ).expect(200);
    expect(
      before.body.data.some(
        (assignment: { tagId: string }) => assignment.tagId === tagA,
      ),
    ).toBe(true);

    await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/members/tags')
        .send({ name: 'Foreign' }),
    ).expect(201);
    const foreignTag = (
      await authed(orgB.accessToken)(
        request(app.getHttpServer()).get('/members/tags'),
      ).expect(200)
    ).body.data.find((tag: { name: string }) => tag.name === 'Foreign');

    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/tags')
        .send({ memberIds: [memberA], tagIds: [foreignTag.id] }),
    ).expect(400);

    const after = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberA}/tags`),
    ).expect(200);
    expect(
      after.body.data.some(
        (assignment: { tagId: string }) => assignment.tagId === tagA,
      ),
    ).toBe(true);
  });

  it('bulk operations never mutate a foreign-tenant member', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/members/bulk/status')
        .send({ memberIds: [memberB], status: 'INACTIVE' }),
    ).expect(200);

    const member = await authed(orgB.accessToken)(
      request(app.getHttpServer()).get(`/members/${memberB}`),
    ).expect(200);
    expect(member.body.data.status).toBe('ACTIVE');
  });

  it('follow-up assignment rejects a user from another tenant', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer()).post(`/members/${memberA}/follow-ups`).send({
        title: 'Cross tenant assignment',
        assignedToUserId: orgB.userId,
      }),
    ).expect(400);
  });
});
