import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';
import { waitForEmailTo } from './utils/mailbox';

/** Proves the password-reset flow end-to-end against real infrastructure:
 * a real SMTP send (to the local smtp-capture-server, see
 * test/global-setup.ts) carrying a real reset token, which is then
 * redeemed against the real API and used to log in with the new
 * password -- not a mocked mailer, not an inspected DB row. */
describe('Password reset (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
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

  it('activates an invited account, so an invitation can actually be accepted', async () => {
    /**
     * The bug this pins: `POST /users` creates a staff account with
     * status INVITED and emails a set-password link, and `login()`
     * refuses anything that is not ACTIVE. Nothing in the codebase ever
     * promoted an INVITED user, so every person ever invited to this
     * product could set a password and then be told their credentials
     * were wrong. Twenty e2e suites flipped the status through Prisma to
     * get past it, which is precisely why nobody noticed.
     */
    const owner = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Invite Acceptance Gym',
        email: `invite-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Invite',
      })
      .expect(201);
    const ownerToken = owner.body.data.accessToken;

    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    const staffEmail = `invited-staff-${Date.now()}@example.com`;
    const invited = await request(app.getHttpServer())
      .post('/users')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        email: staffEmail,
        firstName: 'Newly',
        lastName: 'Invited',
        primaryBranchId: branches.body.data.items[0].id,
        roleKey: 'RECEPTIONIST',
        roleBranchId: branches.body.data.items[0].id,
      })
      .expect(201);

    // Straight from the invitation email -- no Prisma, no hand-flipped
    // status. If the account is not activated by accepting, this fails.
    const sent = await waitForEmailTo(staffEmail, 8000, (email) =>
      /invited/i.test(email.subject),
    );
    const tokenMatch = /[?&]token=([^\s&"<]+)/.exec(sent.body);
    expect(tokenMatch).not.toBeNull();

    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token: decodeURIComponent(tokenMatch![1]),
        newPassword: 'FreshStaffPassword9',
      })
      .expect(204);

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: staffEmail, password: 'FreshStaffPassword9' })
      .expect(201);
    expect(login.body.data.accessToken).toBeTruthy();

    const account = await prisma.user.findUniqueOrThrow({
      where: { id: invited.body.data.id },
      select: { status: true, emailVerifiedAt: true },
    });
    expect(account.status).toBe('ACTIVE');
    // The token went to that address, so accepting it proves control of
    // the mailbox.
    expect(account.emailVerifiedAt).not.toBeNull();
  });

  it('does not reinstate a suspended account through a password reset', async () => {
    // A reset is not a reinstatement. Only INVITED is promoted, or this
    // endpoint becomes a way around an account being switched off.
    const email = `suspended-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Suspended Gym',
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Sus',
        lastName: 'Pended',
      })
      .expect(201);

    await prisma.user.update({
      where: { id: registered.body.data.user.id },
      data: { status: 'SUSPENDED' },
    });

    await request(app.getHttpServer())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(204);
    const sent = await waitForEmailTo(email, 8000, (m) =>
      /reset/i.test(m.subject),
    );
    const match = /[?&]token=([^\s&"<]+)/.exec(sent.body);
    await request(app.getHttpServer())
      .post('/auth/reset-password')
      .send({
        token: decodeURIComponent(match![1]),
        newPassword: 'AnotherPassword99',
      })
      .expect(204);

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: registered.body.data.user.id },
      select: { status: true },
    });
    expect(after.status).toBe('SUSPENDED');
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
