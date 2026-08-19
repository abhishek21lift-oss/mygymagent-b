import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const email = `auth-e2e-${Date.now()}@example.com`;
  const password = 'CorrectHorseBattery9';

  it('registers a new organization + owner and returns an access token', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Auth Test Gym',
        email,
        password,
        firstName: 'Ada',
        lastName: 'Owner',
      })
      .expect(201);

    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.organization.name).toBe('Auth Test Gym');
    // The refresh token must never be exposed in the JSON body.
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(res.headers['set-cookie']?.[0]).toMatch(/refresh_token=/);
  });

  it('rejects registering the same email twice', async () => {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Duplicate Gym',
        email,
        password,
        firstName: 'Dup',
        lastName: 'User',
      })
      .expect(409);
  });

  it('rejects login with a wrong password without revealing whether the account exists', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'wrong-password-here' })
      .expect(401);
    expect(res.body.error.message).toBe('Invalid email or password');

    const resUnknown = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: 'nobody-here@example.com', password: 'whatever12345' })
      .expect(401);
    expect(resUnknown.body.error.message).toBe('Invalid email or password');
  });

  it('logs in and can call the protected /auth/me endpoint', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);

    const accessToken = login.body.data.accessToken;

    const me = await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);

    expect(me.body.data.user.email).toBe(email);
    expect(me.body.data.permissions).toEqual(
      expect.arrayContaining(['members.read', 'members.create']),
    );
  });

  it('rejects protected routes with no token, and with a garbage token', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', 'Bearer not-a-real-token')
      .expect(401);
  });

  it('refreshes the session using the httpOnly cookie and rotates the refresh token', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);

    const cookie = login.headers['set-cookie'][0];

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(201);

    expect(refreshed.body.data.accessToken).toEqual(expect.any(String));
    expect(refreshed.headers['set-cookie']?.[0]).toMatch(/refresh_token=/);

    // The rotated-out cookie must no longer work.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookie)
      .expect(401);
  });

  it('locks the account after repeated failed logins', async () => {
    const lockEmail = `lockout-e2e-${Date.now()}@example.com`;
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Lockout Gym',
        email: lockEmail,
        password,
        firstName: 'Lock',
        lastName: 'Out',
      })
      .expect(201);

    for (let i = 0; i < 5; i++) {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: lockEmail, password: 'still-wrong' })
        .expect(401);
    }

    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: lockEmail, password }) // correct password, but now locked
      .expect(401);
    expect(res.body.error.message).toMatch(/locked/i);
  });
});
