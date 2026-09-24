import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHash } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';
import { Msg91SmsProvider } from '../src/communications/providers/msg91-sms.provider';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * SMS OTP login for members, against real Postgres.
 *
 * MSG91 itself is stubbed: what is under test is who gets in and who
 * does not, which is decided here and not by the carrier. The stub
 * records the code it was asked to deliver, so the tests can prove the
 * code that arrives is the one that works -- and, more importantly, that
 * nothing readable is left in the database afterwards.
 */
describe('Auth / member SMS OTP (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;
  let sent: Array<{ to: string; text: string }>;

  // Unique per run. A fixed number accumulates members across runs, and
  // the service refuses to send to a number two members share -- which
  // is correct behaviour that would otherwise read as a broken test.
  const suffix = String(Date.now()).slice(-6);
  const LOCAL = `98765${suffix.slice(0, 5)}`;
  const PHONE = `+91${LOCAL}`;

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

  async function makeMember(phone: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/members')
      .set('Authorization', `Bearer ${org.accessToken}`)
      .send({
        primaryBranchId: org.branchId,
        firstName: 'Sms',
        lastName: 'Member',
        phone,
      })
      .expect(201);
    return res.body.data.id as string;
  }

  /** Not async: callers chain supertest's own .expect() on the Test. */
  function requestCode(phone: string) {
    return request(app.getHttpServer())
      .post('/auth/otp/request')
      .send({ phone });
  }

  /** Clears the per-number cooldown so a test can ask for a fresh code. */
  async function clearCooldown(phone: string) {
    await prisma.memberOtpChallenge.updateMany({
      where: { phone },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    // Stand in for MSG91 and capture what it was handed.
    sent = [];
    const provider = app.get(Msg91SmsProvider);
    jest.spyOn(provider, 'isConfigured').mockReturnValue(true);
    jest
      .spyOn(provider, 'send')
      .mockImplementation(async (m: { to: string; text: string }) => {
        sent.push({ to: m.to, text: m.text });
        return 'stub-request-id';
      });

    org = await registerOrg('Sms Otp Gym');
    await makeMember(PHONE);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  beforeEach(() => {
    sent.length = 0;
  });

  it('sends a six-digit code and stores only its hash', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
    expect(sent[0].text).toMatch(/^[0-9]{6}$/);

    const row = await prisma.memberOtpChallenge.findFirstOrThrow({
      where: { phone: PHONE },
      orderBy: { createdAt: 'desc' },
    });
    // The readable code must not be anywhere in the row.
    expect(JSON.stringify(row)).not.toContain(sent[0].text);
    expect(row.codeHash).toBe(
      createHash('sha256').update(sent[0].text).digest('hex'),
    );
  });

  it('logs the member in with the code and starts a member session', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const code = sent[0].text;

    const res = await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(201);

    expect(res.body.data.accessToken).toBeTruthy();
    // The session knows it belongs to a member, which is what routes the
    // client to the portal rather than the staff app.
    expect(res.body.data.user.memberId).toBeTruthy();
    // No email was ever collected for this person.
    expect(res.body.data.user.email).toBeNull();

    // And the session actually works.
    await request(app.getHttpServer())
      .get('/portal/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);
  });

  it('accepts the number typed without a country code', async () => {
    await clearCooldown(PHONE);
    await requestCode(LOCAL).expect(201);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(PHONE);
  });

  it('refuses a wrong code, and the right one still works afterwards', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const code = sent[0].text;
    const wrong = code === '000000' ? '111111' : '000000';

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code: wrong })
      .expect(401);

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(201);
  });

  it('spends a code: the same one cannot be used twice', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const code = sent[0].text;

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(201);

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(401);
  });

  it('stops guessing after five wrong attempts, even with the right code', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const code = sent[0].text;
    const wrong = code === '000000' ? '111111' : '000000';

    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/auth/otp/verify')
        .send({ phone: PHONE, code: wrong })
        .expect(401);
    }

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(401);
  });

  it('will not accept an expired code', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    const code = sent[0].text;

    await prisma.memberOtpChallenge.updateMany({
      where: { phone: PHONE, consumedAt: null },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await request(app.getHttpServer())
      .post('/auth/otp/verify')
      .send({ phone: PHONE, code })
      .expect(401);
  });

  it('answers a number that belongs to nobody exactly like one that does', async () => {
    await clearCooldown(PHONE);
    const known = await requestCode(PHONE).expect(201);
    const unknown = await requestCode('+919000000001').expect(201);

    // Same shape, same body: this endpoint is not a membership lookup.
    expect(unknown.body.data).toEqual(known.body.data);
    // Nothing was sent for the unknown number.
    expect(sent.filter((s) => s.to === '+919000000001')).toHaveLength(0);
  });

  it('does not send a second code inside the cooldown', async () => {
    await clearCooldown(PHONE);
    await requestCode(PHONE).expect(201);
    expect(sent).toHaveLength(1);

    // Same generic answer, no second message.
    await requestCode(PHONE).expect(201);
    expect(sent).toHaveLength(1);
  });

  it('will not guess between two members sharing one number', async () => {
    const shared = `+9198760${suffix.slice(0, 5)}`;
    await makeMember(shared);
    await makeMember(shared);
    await clearCooldown(shared);

    await requestCode(shared).expect(201);
    // Sending would log whoever typed the code into an account that may
    // not be theirs.
    expect(sent.filter((s) => s.to === shared)).toHaveLength(0);
  });
});
