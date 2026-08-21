import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/test-app';
import { waitForEmailTo } from './utils/mailbox';

/** Proves the password-reset flow end-to-end against real infrastructure:
 * a real SMTP send (to the local smtp-capture-server, see
 * test/global-setup.ts) carrying a real reset token, which is then
 * redeemed against the real API and used to log in with the new
 * password -- not a mocked mailer, not an inspected DB row. */
describe('Password reset (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('emails a working reset link that lets the user log in with a new password', async () => {
    const email = `reset-${Date.now()}@example.com`;
    const oldPassword = 'CorrectHorseBattery9';
    const newPassword = 'DifferentHorseBattery7';

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Password Reset Gym',
        email,
        password: oldPassword,
        firstName: 'Riley',
        lastName: 'Reset',
      })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(204);

    const sent = await waitForEmailTo(email);
    expect(sent.subject.toLowerCase()).toContain('reset');

    const tokenMatch = /[?&]token=([^\s&"]+)/.exec(sent.body);
    expect(tokenMatch).not.toBeNull();
    const token = decodeURIComponent(tokenMatch![1]);

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({ token, newPassword })
      .expect(204);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: oldPassword })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: newPassword })
      .expect(201);
  });

  it('does not send a reset email for an unknown address, and does not error', async () => {
    const email = `no-such-user-${Date.now()}@example.com`;

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(204);

    await expect(waitForEmailTo(email, 1000)).rejects.toThrow(/Timed out/);
  });
});
