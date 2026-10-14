import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The settings/whatsapp screen's server state: per-gym WhatsappProfile
 * rows behind GET/PATCH /automation/whatsapp-profile, the read-only
 * irregular-members preview behind GET /automation/irregular-members,
 * and the scheduled-time (runAt) writes the Control Center PATCHes to
 * /automation/settings/:key. Every route is tenant-scoped: one gym's
 * profile, preview, or schedule never touches another's.
 */
describe('Automation messaging profile (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let org: RegisteredAccount;
  let other: RegisteredAccount;

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
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    org = await registerOrg('Messaging Profile Gym');
    other = await registerOrg('Messaging Profile Other Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('answers merged defaults without creating a row', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/whatsapp-profile'),
    ).expect(200);

    expect(res.body.data).toMatchObject({
      organizationId: org.organizationId,
      salutation: 'Hello',
      autoResend: false,
      maxResendAttempts: 3,
      defaultCountryCode: '91',
      customBillMessage: null,
      irregularThresholdDays: 14,
      irregularCustomDays: null,
      updatedAt: null,
    });
    expect(typeof res.body.data.timezone).toBe('string');

    const rows = await prisma.whatsappProfile.count({
      where: { organizationId: org.organizationId },
    });
    expect(rows).toBe(0);
  });

  it('round-trips a full update and preserves untouched fields on partial writes', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).patch('/automation/whatsapp-profile').send({
        salutation: 'Respected',
        autoResend: true,
        maxResendAttempts: 5,
        defaultCountryCode: '91',
        customBillMessage:
          '{{salutation}} {{firstName}}, invoice {{invoiceNumber}} for {{amount}} is due on {{dueDate}}.',
        irregularThresholdDays: 21,
      }),
    ).expect(200);

    const afterFull = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/whatsapp-profile'),
    ).expect(200);
    expect(afterFull.body.data).toMatchObject({
      salutation: 'Respected',
      autoResend: true,
      maxResendAttempts: 5,
      irregularThresholdDays: 21,
    });
    expect(afterFull.body.data.updatedAt).not.toBeNull();

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/whatsapp-profile')
        .send({ salutation: 'Hi' }),
    ).expect(200);

    const afterPartial = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/whatsapp-profile'),
    ).expect(200);
    expect(afterPartial.body.data.salutation).toBe('Hi');
    // Untouched fields survive a partial write.
    expect(afterPartial.body.data.autoResend).toBe(true);
    expect(afterPartial.body.data.maxResendAttempts).toBe(5);
  });

  it.each([
    [{ salutation: 'Yo' }, 'salutation'],
    [{ maxResendAttempts: 9 }, 'maxResendAttempts'],
    [{ maxResendAttempts: 0 }, 'maxResendAttempts'],
    [{ defaultCountryCode: 'abc' }, 'defaultCountryCode'],
    [{ defaultCountryCode: '12345' }, 'defaultCountryCode'],
    [{ customBillMessage: 'Pay {{hackerman}} now' }, 'customBillMessage'],
    [{ irregularThresholdDays: 0 }, 'irregularThresholdDays'],
    [{ irregularThresholdDays: 91 }, 'irregularThresholdDays'],
  ])('rejects invalid profile input %j', async (body) => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/whatsapp-profile')
        .send(body),
    ).expect(400);
  });

  it('isolates profiles per tenant', async () => {
    // The other gym sees only its own defaults -- never org's row.
    const res = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/automation/whatsapp-profile'),
    ).expect(200);
    expect(res.body.data.organizationId).toBe(other.organizationId);
    expect(res.body.data.salutation).toBe('Hello');

    // A write lands only on the caller's own row.
    await authed(other.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/whatsapp-profile')
        .send({ salutation: 'Greetings' }),
    ).expect(200);

    const mine = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/whatsapp-profile'),
    ).expect(200);
    expect(mine.body.data.salutation).toBe('Hi');
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer())
      .get('/automation/whatsapp-profile')
      .expect(401);
    await request(app.getHttpServer())
      .get('/automation/irregular-members')
      .expect(401);
  });

  it('answers an empty irregular-members report with the saved threshold', async () => {
    const res = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/automation/irregular-members'),
    ).expect(200);

    expect(res.body.data.thresholdDays).toBe(14);
    expect(typeof res.body.data.generatedAt).toBe('string');
    expect(res.body.data.members).toEqual([]);
  });

  it('honours an explicit range and rejects out-of-range values', async () => {
    const res = await authed(other.accessToken)(
      request(app.getHttpServer()).get(
        '/automation/irregular-members?rangeDays=30',
      ),
    ).expect(200);
    expect(res.body.data.thresholdDays).toBe(30);

    await authed(other.accessToken)(
      request(app.getHttpServer()).get(
        '/automation/irregular-members?rangeDays=0',
      ),
    ).expect(400);
    await authed(other.accessToken)(
      request(app.getHttpServer()).get(
        '/automation/irregular-members?rangeDays=91',
      ),
    ).expect(400);
  });

  it('lists a lapsed member with computed inactivity', async () => {
    const code = `IRREG-${Date.now()}`;
    const member = await prisma.member.create({
      data: {
        organizationId: other.organizationId,
        primaryBranchId: other.branchId,
        memberCode: code,
        firstName: 'Lapsed',
        lastName: 'Lydia',
        phone: '+911234567890',
      },
    });
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    await prisma.attendance.create({
      data: {
        organizationId: other.organizationId,
        branchId: other.branchId,
        memberId: member.id,
        checkInAt: twentyDaysAgo,
      },
    });

    const res = await authed(other.accessToken)(
      request(app.getHttpServer()).get(
        '/automation/irregular-members?rangeDays=7',
      ),
    ).expect(200);

    const row = (res.body.data.members as Array<Record<string, unknown>>).find(
      (m) => m.id === member.id,
    );
    expect(row).toMatchObject({
      name: 'Lapsed Lydia',
      phone: '+911234567890',
      subscriptionStatus: 'NONE',
      membershipEndDate: null,
    });
    expect(typeof row?.lastCheckInAt).toBe('string');
    expect(row?.daysInactive as number).toBeGreaterThanOrEqual(7);
    for (const m of res.body.data.members as Array<{ daysInactive: number }>) {
      expect(m.daysInactive).toBeGreaterThanOrEqual(7);
    }
  });

  it('writes and reads back a scheduled run time per key', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/MEMBER_INACTIVE_RECOVERY')
        .send({ runAt: '08:30' }),
    ).expect(200);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/settings'),
    ).expect(200);
    const row = (
      res.body.data as Array<{ key: string; runAt: string | null }>
    ).find((r) => r.key === 'MEMBER_INACTIVE_RECOVERY');
    expect(row?.runAt).toBe('08:30');

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/MEMBER_INACTIVE_RECOVERY')
        .send({ runAt: '25:00' }),
    ).expect(400);
  });
});
