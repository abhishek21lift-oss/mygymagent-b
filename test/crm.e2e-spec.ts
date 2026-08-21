import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('CRM / leads (e2e)', () => {
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
    app = await createTestApp();
    org = await registerOrg('CRM Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates a lead, moves it through the pipeline, and rejects setting WON directly', async () => {
    const lead = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Jamie',
        lastName: 'Prospect',
        email: 'jamie@example.com',
        source: 'walk-in',
        branchId: org.branchId,
      }),
    ).expect(201);
    expect(lead.body.data.status).toBe('NEW');

    const contacted = await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/leads/${lead.body.data.id}/status`)
        .send({ status: 'CONTACTED' }),
    ).expect(200);
    expect(contacted.body.data.status).toBe('CONTACTED');

    // WON is only settable via /convert, not the plain status endpoint.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch(`/leads/${lead.body.data.id}/status`)
        .send({ status: 'WON' }),
    ).expect(400);
  });

  it('adds and completes a follow-up on a lead', async () => {
    const lead = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Follow',
        lastName: 'UpTest',
      }),
    ).expect(201);

    const followUp = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${lead.body.data.id}/follow-ups`)
        .send({
          dueAt: new Date(Date.now() + 86400000).toISOString(),
          note: 'Call back',
        }),
    ).expect(201);
    expect(followUp.body.data.completedAt).toBeNull();

    const detail = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/leads/${lead.body.data.id}`),
    ).expect(200);
    expect(detail.body.data.followUps).toHaveLength(1);

    const completed = await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/leads/${lead.body.data.id}/follow-ups/${followUp.body.data.id}/complete`,
      ),
    ).expect(200);
    expect(completed.body.data.completedAt).not.toBeNull();
  });

  it('converts a lead into a real member, and rejects converting twice', async () => {
    const lead = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Convert',
        lastName: 'Me',
        email: 'convert.me@example.com',
        branchId: org.branchId,
      }),
    ).expect(201);

    const converted = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${lead.body.data.id}/convert`)
        .send({}),
    ).expect(201);
    expect(converted.body.data.lead.status).toBe('WON');
    expect(converted.body.data.member.firstName).toBe('Convert');
    expect(converted.body.data.lead.convertedMemberId).toBe(
      converted.body.data.member.id,
    );

    // The new member is real and independently readable.
    await authed(org.accessToken)(
      request(app.getHttpServer()).get(
        `/members/${converted.body.data.member.id}`,
      ),
    ).expect(200);

    // Converting again is rejected.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${lead.body.data.id}/convert`)
        .send({}),
    ).expect(400);
  });

  it('rejects converting a lead with no branch on file and no branchId supplied', async () => {
    const lead = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'NoBranch',
        lastName: 'Lead',
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${lead.body.data.id}/convert`)
        .send({}),
    ).expect(400);
  });

  it('filters the list by status', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Qualified',
        lastName: 'Lead',
      }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/leads').query({ status: 'NEW' }),
    ).expect(200);
    expect(
      res.body.data.items.every((l: { status: string }) => l.status === 'NEW'),
    ).toBe(true);
  });
});
