import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';

describe('Auth (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
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

  it('revokes the whole token family when a rotated-out refresh token is replayed', async () => {
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);

    const firstCookie = login.headers['set-cookie'][0];

    const refreshed = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(201);
    const secondCookie = refreshed.headers['set-cookie'][0];

    // Replaying the rotated-out token is a compromise signal: the entire
    // session family must die, including the still-fresh second cookie.
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', firstCookie)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', secondCookie)
      .expect(401);
  });

  it('does not let a token killed by a mass revocation sign out a newer session', async () => {
    // Two browsers on one account, each with its own session.
    const loginA = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const loginB = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const cookieA = loginA.headers['set-cookie'][0];
    const cookieB = loginB.headers['set-cookie'][0];

    // A replays a rotated token: the family dies, B's token with it.
    const rotated = await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieA)
      .expect(201);
    expect(rotated.headers['set-cookie']?.[0]).toMatch(/refresh_token=/);
    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieA)
      .expect(401);

    // A signs back in. B then refreshes with its now-dead token: that is
    // a 401 for B, and nothing more -- A's new session must survive it.
    const relogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const freshCookie = relogin.headers['set-cookie'][0];

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', cookieB)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', freshCookie)
      .expect(201);
  });

  it('does not treat a logged-out token as a replay', async () => {
    const loggedOut = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const other = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(201);
    const loggedOutCookie = loggedOut.headers['set-cookie'][0];

    await request(app.getHttpServer())
      .post('/auth/logout')
      .set('Cookie', loggedOutCookie)
      .expect((res) => expect(res.status).toBeLessThan(300));

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', loggedOutCookie)
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/refresh')
      .set('Cookie', other.headers['set-cookie'][0])
      .expect(201);
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

    // Correct password is rejected: the account is locked. The message must
    // stay identical to a plain password mismatch -- a distinct "locked"
    // message would be an account-existence oracle for email enumeration.
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: lockEmail, password })
      .expect(401);
    expect(res.body.error.message).toBe('Invalid email or password');
  });
});
