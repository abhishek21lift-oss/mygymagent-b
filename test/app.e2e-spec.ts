import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

describe('Health (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('/health (GET) is public liveness check', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('/ready (GET) is public and reports the database as up', async () => {
    const res = await request(app.getHttpServer()).get('/ready').expect(200);
    expect(res.body.data.status).toBe('ready');
    expect(res.body.data.database).toBe('up');
  });
});
