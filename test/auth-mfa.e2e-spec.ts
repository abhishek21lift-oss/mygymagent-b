import type { INestApplication } from '@nestjs/common';
import { authenticator } from 'otplib';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './utils/test-app';

/**
 * B-P0-4 (BACKLOG.md): TOTP second factor for staff accounts.
 *
 * The properties worth pinning down here are the ones that make 2FA real
 * rather than decorative:
 *  - a correct password alone yields NO session once MFA is enrolled;
 *  - the challenge token is not a bearer credential (JwtStrategy rejects
 *    any non-`access` token type, so it cannot be swapped for a session);
 *  - a code cannot be replayed inside its own 30s window;
 *  - recovery codes are single-use;
 *  - wrong codes burn the same lockout budget as wrong passwords, because
 *    a 6-digit keyspace is small enough to brute force otherwise;
 *  - a *pending* enrolment never gates login (a half-finished setup must
 *    not lock someone out of their own account).
 */
describe('Auth MFA (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let email: string;
  let userId: string;
  let accessToken: string;
  let secret: string;
  let recoveryCodes: string[];

  const password = 'CorrectHorseBattery9';
  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  const login = () =>
    request(app.getHttpServer()).post('/auth/login').send({ email, password });

  const code = () => authenticator.generate(secret);

  /** Failed second-factor attempts deliberately share the password lockout
   * counter, so tests that assert failures reset it before moving on. */
  const resetLockout = () =>
    prisma.user.update({
      where: { id: userId },
      data: { failedLoginAttempts: 0, lockedUntil: null },
    });

  /**
   * Stands in for waiting out the 30-second TOTP step, without sleeping.
   *
   * The replay guard refuses any step at or below the last accepted one,
   * and the accepted drift window is only +/-1 step, so two *successful*
   * verifications genuinely cannot happen inside one 30s window -- that is
   * the feature working, not a bug. Rather than add 30s of sleep per
   * assertion, tests that need a second success clear the stored marker,
   * which is exactly the state a real user reaches when their
   * authenticator rolls over. The replay assertion below deliberately does
   * NOT call this.
   */
  const advanceTotpWindow = () =>
    prisma.userMfa.update({
      where: { userId },
      data: { lastUsedStep: null },
    });

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    email = `mfa-owner-${Date.now()}@example.com`;
    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'MFA Test Gym',
        email,
        password,
        firstName: 'Owner',
        lastName: 'Mfa',
      })
      .expect(201);
    accessToken = registered.body.data.accessToken;
    userId = registered.body.data.user.id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('reports MFA off before enrolment', async () => {
    const res = await authed(accessToken)(
      request(app.getHttpServer()).get('/auth/mfa'),
    ).expect(200);
    expect(res.body.data).toEqual({
      enabled: false,
      pendingEnrolment: false,
      recoveryCodesRemaining: 0,
    });
  });

  it('issues a secret and otpauth URI for the authenticator app', async () => {
    const res = await authed(accessToken)(
      request(app.getHttpServer()).post('/auth/mfa/setup'),
    ).expect(201);
    secret = res.body.data.secret;
    expect(secret).toMatch(/^[A-Z2-7]+$/); // base32
    expect(res.body.data.otpauthUri).toContain('otpauth://totp/');
    expect(res.body.data.otpauthUri).toContain('MFA%20Test%20Gym');
  });

  it('does not gate login while enrolment is only pending', async () => {
    // A secret exists but possession has not been proven. If this gated
    // login, an abandoned setup would lock the user out of their account.
    const res = await login().expect(201);
    expect(res.body.data.mfaRequired).toBeUndefined();
    expect(res.body.data.accessToken).toBeTruthy();
  });

  it('rejects a wrong code at enable time', async () => {
    await authed(accessToken)(
      request(app.getHttpServer())
        .post('/auth/mfa/enable')
        .send({ code: '000000' }),
    ).expect(401);
    await resetLockout();
  });

  it('enables MFA on a correct code and returns recovery codes once', async () => {
    const res = await authed(accessToken)(
      request(app.getHttpServer())
        .post('/auth/mfa/enable')
        .send({ code: code() }),
    ).expect(201);
    recoveryCodes = res.body.data.recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);

    const status = await authed(accessToken)(
      request(app.getHttpServer()).get('/auth/mfa'),
    ).expect(200);
    expect(status.body.data.enabled).toBe(true);
    expect(status.body.data.recoveryCodesRemaining).toBe(10);
  });

  it('stores the secret only as an encrypted envelope', async () => {
    const row = await prisma.userMfa.findUniqueOrThrow({ where: { userId } });
    expect(row.secretEnc).not.toContain(secret);
    expect(row.secretEnc.startsWith('v1.')).toBe(true);
  });

  it('refuses to re-enrol while enabled', async () => {
    await authed(accessToken)(
      request(app.getHttpServer()).post('/auth/mfa/setup'),
    ).expect(409);
  });

  it('withholds the session on password-only login once enrolled', async () => {
    const res = await login().expect(201);
    expect(res.body.data.mfaRequired).toBe(true);
    expect(res.body.data.mfaToken).toBeTruthy();
    expect(res.body.data.accessToken).toBeUndefined();
    // No refresh cookie either -- nothing resumable is handed out yet.
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('will not accept the challenge token as a bearer credential', async () => {
    // The whole factor collapses if this token can stand in for a session.
    const challenge = await login().expect(201);
    await authed(challenge.body.data.mfaToken)(
      request(app.getHttpServer()).get('/auth/me'),
    ).expect(401);
  });

  it('rejects a wrong code at the challenge', async () => {
    const challenge = await login().expect(201);
    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: challenge.body.data.mfaToken, code: '000000' })
      .expect(401);
    await resetLockout();
  });

  it('rejects a forged challenge token', async () => {
    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: 'not.a.real.token', code: code() })
      .expect(401);
  });

  it('completes the login with a valid code and issues a usable session', async () => {
    await advanceTotpWindow();
    const challenge = await login().expect(201);
    const used = code();
    const verified = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: challenge.body.data.mfaToken, code: used })
      .expect(201);

    expect(verified.body.data.accessToken).toBeTruthy();
    expect(verified.headers['set-cookie']).toBeDefined();
    await authed(verified.body.data.accessToken)(
      request(app.getHttpServer()).get('/auth/me'),
    ).expect(200);

    // Replaying the very same code must fail even though it is still
    // inside its validity window.
    const replayChallenge = await login().expect(201);
    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: replayChallenge.body.data.mfaToken, code: used })
      .expect(401);
    await resetLockout();
  });

  it('accepts a recovery code once and then burns it', async () => {
    const recovery = recoveryCodes[0];

    const first = await login().expect(201);
    const verified = await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: first.body.data.mfaToken, code: recovery })
      .expect(201);
    expect(verified.body.data.accessToken).toBeTruthy();

    const second = await login().expect(201);
    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: second.body.data.mfaToken, code: recovery })
      .expect(401);
    await resetLockout();

    const status = await authed(accessToken)(
      request(app.getHttpServer()).get('/auth/mfa'),
    ).expect(200);
    expect(status.body.data.recoveryCodesRemaining).toBe(9);
  });

  it('locks the account after repeated bad codes, like repeated bad passwords', async () => {
    const challenge = await login().expect(201);
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer())
        .post('/auth/mfa/verify')
        .send({ mfaToken: challenge.body.data.mfaToken, code: '000000' })
        .expect(401);
    }

    // Now even a *correct* code is refused while the lockout holds.
    await request(app.getHttpServer())
      .post('/auth/mfa/verify')
      .send({ mfaToken: challenge.body.data.mfaToken, code: code() })
      .expect(401);

    const locked = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { lockedUntil: true },
    });
    expect(locked.lockedUntil).toBeTruthy();
    await resetLockout();
  });

  describe('disabling', () => {
    it('requires the password as well as a code', async () => {
      await authed(accessToken)(
        request(app.getHttpServer())
          .post('/auth/mfa/disable')
          .send({ password: 'not-the-password', code: code() }),
      ).expect(401);

      const stillOn = await authed(accessToken)(
        request(app.getHttpServer()).get('/auth/mfa'),
      ).expect(200);
      expect(stillOn.body.data.enabled).toBe(true);
    });

    it('disables on a valid password + code, removing the stored secret', async () => {
      await advanceTotpWindow();
      await authed(accessToken)(
        request(app.getHttpServer())
          .post('/auth/mfa/disable')
          .send({ password, code: code() }),
      ).expect(201);

      expect(await prisma.userMfa.findUnique({ where: { userId } })).toBeNull();
      expect(
        await prisma.mfaRecoveryCode.count({ where: { userMfa: { userId } } }),
      ).toBe(0);
    });

    it('returns login to a single factor afterwards', async () => {
      const res = await login().expect(201);
      expect(res.body.data.mfaRequired).toBeUndefined();
      expect(res.body.data.accessToken).toBeTruthy();
    });
  });
});
