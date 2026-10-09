import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
// MUST stay first: selects OTP_PROVIDER=mock before anything pulls in
// AppModule, whose ConfigModule snapshots the validated environment at
// import time. See the file for why beforeAll is too late.
import {
  MOCK_OTP_CODE,
  MOCK_OTP_TTL_SECONDS,
  restoreOtpEnv,
} from './utils/mock-otp-env';
import { PrismaService } from '../src/prisma/prisma.service';
import { Msg91SmsProvider } from '../src/communications/providers/msg91-sms.provider';
import { MockOtpDelivery } from '../src/auth/otp-delivery/mock-otp-delivery';
import { OTP_DELIVERY } from '../src/auth/otp-delivery/otp-delivery.interface';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Member OTP login with `OTP_PROVIDER=mock`, against real Postgres.
 *
 * The point of the mock provider is that the whole flow can be exercised
 * with no carrier account, no DLT-registered template and no handset —
 * so this suite drives the real HTTP endpoints, the real challenge rows
 * and the real session, and only the delivery step is a no-op.
 *
 * What it deliberately does NOT assert: that the mock is safe in
 * production. That is asserted where the guarantee actually lives — the
 * env schema refusing to boot (`src/config/env.validation.spec.ts`) and
 * the provider's own constructor and `isConfigured()` guards
 * (`src/auth/otp-delivery/otp-delivery.spec.ts`). A test that merely
 * checked "mock + production = broken" against a mock app would be
 * asserting a rule about a test fixture, not about the system.
 *
 * The real MSG91 path is covered separately by
 * `member-sms-otp.e2e-spec.ts`, which stubs the carrier and must keep
 * running on the `msg91` provider.
 */
describe('Auth / member OTP via the mock provider (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;

  // Unique per run, same reason as the MSG91 suite: a fixed number
  // accumulates members across runs and the service refuses to send to
  // a number two members share.
  const suffix = String(Date.now()).slice(-6);
  const PHONE = `+9198771${suffix.slice(0, 5)}`;
  const LOCAL = `98771${suffix.slice(0, 5)}`;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}@example.com`,
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

  async function makeMember(phone: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/members')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .send({
        primaryBranchId: org.branchId,
        firstName: 'Mock',
        lastName: 'Otp',
        phone,
      })
      .expect(201);
    return res.body.data.id as string;
  }

  function requestCode(phone: string) {
    return request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone });
  }

  function verifyCode(phone: string, code: string) {
    return request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone, code });
  }

  /**
   * Starts a test from a clean slate for this number, matched on the
   * stored `+91...` form.
   *
   * Two updates, and the split matters. The resend cooldown looks at
   * *every* challenge for the number, spent ones included, so the
   * `createdAt` backdate cannot be narrowed to unconsumed rows or the
   * previous test's spent code suppresses this test's request. The
   * expiry, on the other hand, only needs to reach live rows.
   *
   * Expiring the leftovers at all is only needed under the mock, and the
   * reason is a real difference between the providers rather than
   * between the suites: every challenge row holds the same fixed hash
   * here, so a leftover unconsumed row would still satisfy a later
   * `verify` and the "spent code" and "expired code" cases would pass a
   * code nobody just issued. Under MSG91 each row holds a different
   * CSPRNG hash, so a stale row simply fails to match and that suite
   * never had to clean up after itself.
   */
  async function clearCooldown(phone: string) {
    await prisma.memberOtpChallenge.updateMany({
      where: { phone },
      // Past the daily limit's window too, not just the cooldown.
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60_000) },
    });
    await prisma.memberOtpChallenge.updateMany({
      where: { phone, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    org = await registerOrg('Mock Otp Gym');
    await makeMember(PHONE);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
    restoreOtpEnv();
  });

  it('actually bound the mock provider, so the rest of the suite is not vacuous', () => {
    // If this ever fails, every test below is asserting against the
    // MSG91 provider — which is unconfigured here, so `/auth/otp/request`
    // would 400 and the failures would be misleading rather than obvious.
    expect(app.get(OTP_DELIVERY)).toBeInstanceOf(MockOtpDelivery);
  });

  it('sends nothing, and never needs a carrier configured', async () => {
    // No MSG91 credentials exist in this environment. If the mock path
    // quietly depended on them, this would 400 and the suite would be
    // testing the "SMS login is not configured" branch instead.
    const carrier = app.get(Msg91SmsProvider);
    const spy = jest.spyOn(carrier, 'send');
    const configured = carrier.isConfigured();

    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    expect(spy).not.toHaveBeenCalled();
    expect(configured).toBe(false);
    spy.mockRestore();
  });

  it('issues the fixed code, hashed, with the configured lifetime', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    const row = await prisma.memberOtpChallenge.findFirstOrThrow({
      where: { phone: PHONE },
      orderBy: { createdAt: 'desc' },
    });

    // The stored hash is the mock code's, so the flow being exercised is
    // the real hash-and-compare path rather than a bypass of it.
    expect(row.codeHash).toBe(
      createHash('sha256').update(MOCK_OTP_CODE).digest('hex'),
    );
    // And no readable code anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(MOCK_OTP_CODE);

    // OTP_EXPIRY_SECONDS actually drove the window rather than a constant
    // that happens to equal it.
    const lifetimeSeconds = Math.round(
      (row.expiresAt.getTime() - row.createdAt.getTime()) / 1000,
    );
    expect(lifetimeSeconds).toBe(MOCK_OTP_TTL_SECONDS);
  });

  it('never returns the code in the response, in any state', async () => {
    await clearCooldown(PHONE);
    const sent = await requestCode(PHONE).expect(201);
    expect(JSON.stringify(sent.body)).not.toContain(MOCK_OTP_CODE);
    expect(sent.body.data).toEqual({
      sent: true,
      expiresInSeconds: MOCK_OTP_TTL_SECONDS,
    });

    // Same for a number that belongs to nobody, and for a failed verify:
    // a code appearing in an error body would be worse than in a success.
    const unknown = await requestCode('+919000000002').expect(201);
    expect(JSON.stringify(unknown.body)).not.toContain(MOCK_OTP_CODE);

    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const refused = await verifyCode(PHONE, '000000').expect(401);
    expect(JSON.stringify(refused.body)).not.toContain(MOCK_OTP_CODE);
  });

  it('logs the member in with the fixed code, and the session works', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    const res = await verifyCode(PHONE, MOCK_OTP_CODE).expect(201);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.body.data.user.memberId).toBeTruthy();

    await request(app.getHttpServer())
      .get('/portal/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
  });

  it('accepts the number typed without a country code', async () => {
    // Cleared by the stored form: the challenge is written under the
    // member's own `+91...` phone, and the cooldown looks that up, so
    // clearing by the local number would silently match nothing.
    await clearCooldown(PHONE);
    await requestCode(LOCAL).expect(201);

    const row = await prisma.memberOtpChallenge.findFirstOrThrow({
      where: { phone: PHONE },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.codeHash).toBe(
      createHash('sha256').update(MOCK_OTP_CODE).digest('hex'),
    );

    await verifyCode(LOCAL, MOCK_OTP_CODE).expect(201);
  });

  it('refuses a wrong code, and the right one still works afterwards', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    await verifyCode(PHONE, '000000').expect(401);
    await verifyCode(PHONE, MOCK_OTP_CODE).expect(201);
  });

  it('spends the code: the same one cannot be used twice', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    await verifyCode(PHONE, MOCK_OTP_CODE).expect(201);
    await verifyCode(PHONE, MOCK_OTP_CODE).expect(401);
  });

  it('stops guessing after five wrong attempts, even with the right code', async () => {
    // The mock must not skip the attempt limit just because the code is
    // known: a provider that did would be testing a flow the deployed
    // system does not have.
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    for (let i = 0; i < 5; i += 1) {
      await verifyCode(PHONE, '000000').expect(401);
    }
    await verifyCode(PHONE, MOCK_OTP_CODE).expect(401);
  });

  it('will not accept a code past its expiry', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    const row = await prisma.memberOtpChallenge.findFirstOrThrow({
      where: { phone: PHONE, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());

    // Wind the clock forward past the window rather than waiting it out.
    await prisma.memberOtpChallenge.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await verifyCode(PHONE, MOCK_OTP_CODE).expect(401);
  });

  it('answers a number that belongs to nobody exactly like one that does', async () => {
    await clearCooldown(PHONE);
    const known = await requestCode(PHONE).expect(201);
    const unknown = await requestCode('+919000000003').expect(201);

    expect(unknown.body.data).toEqual(known.body.data);
  });

  it('does not issue a second code inside the resend cooldown', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    const before = await prisma.memberOtpChallenge.count({
      where: { phone: PHONE, consumedAt: null },
    });
    await requestCode(PHONE).expect(201);
    const after = await prisma.memberOtpChallenge.count({
      where: { phone: PHONE, consumedAt: null },
    });

    expect(after).toBe(before);
  });
  it('lets two requests racing with one code start one session', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    const results = await Promise.all([
      verifyCode(PHONE, MOCK_OTP_CODE),
      verifyCode(PHONE, MOCK_OTP_CODE),
      verifyCode(PHONE, MOCK_OTP_CODE),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s < 300)).toHaveLength(1);
    expect(statuses.filter((s) => s === 401)).toHaveLength(2);
  });

  it('refuses even the right code once the guess budget is spent', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    // Two waves of four: the second races for the one guess left, which
    // a read-then-increment let all four take.
    const wave = () =>
      Promise.all(Array.from({ length: 4 }, () => verifyCode(PHONE, '000001')));
    const results = [...(await wave()), ...(await wave())];
    expect(results.every((r) => r.status === 401)).toBe(true);
    const row = await prisma.memberOtpChallenge.findFirstOrThrow({
      where: { phone: PHONE, consumedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    // Eight parallel guesses, five counted: the budget is checked and
    // spent in one write.
    expect(row.attempts).toBe(5);
    await verifyCode(PHONE, MOCK_OTP_CODE).expect(401);
  });
});
