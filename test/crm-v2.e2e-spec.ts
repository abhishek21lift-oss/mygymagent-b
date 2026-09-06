import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Sales OS v2 (e2e)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    const email = `sales-v2-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Sales V2 Test Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Sales',
        lastName: 'Owner',
      })
      .expect(201);
    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
    org = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  const auth = () => ({
    Authorization: `Bearer ${org.accessToken}`,
  });

  it('lists global follow-ups with tenant and branch scope', async () => {
    const lead = await request(app.getHttpServer())
      .post('/leads')
      .set(auth())
      .send({ firstName: 'Follow', lastName: 'Up', branchId: org.branchId })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/leads/${lead.body.data.id}/follow-ups`)
      .set(auth())
      .send({
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        note: 'Call tomorrow',
      })
      .expect(201);

    const result = await request(app.getHttpServer())
      .get('/lead-follow-ups')
      .query({ status: 'OPEN', page: 1, pageSize: 20 })
      .set(auth())
      .expect(200);

    expect(result.body.data.items).toHaveLength(1);
    expect(result.body.data.items[0].lead.id).toBe(lead.body.data.id);
  });

  it('reports source performance from real leads', async () => {
    await request(app.getHttpServer())
      .post('/leads')
      .set(auth())
      .send({ firstName: 'Instagram', lastName: 'Lead', source: 'Instagram', branchId: org.branchId })
      .expect(201);
    const won = await request(app.getHttpServer())
      .post('/leads')
      .set(auth())
      .send({ firstName: 'Referral', lastName: 'Lead', source: 'Referral', branchId: org.branchId })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/leads/${won.body.data.id}/convert`)
      .set(auth())
      .send({ branchId: org.branchId })
      .expect(201);

    const result = await request(app.getHttpServer())
      .get('/analytics/sales/sources')
      .set(auth())
      .expect(200);

    const referral = result.body.data.find((row: { source: string }) => row.source === 'Referral');
    expect(referral).toEqual(expect.objectContaining({ totalLeads: 1, wonLeads: 1, conversionRatePct: '100.00' }));
  });
});
