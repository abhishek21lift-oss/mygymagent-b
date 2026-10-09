import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AutomationSettingsService } from '../src/automation/automation-settings.service';
import { MemberMessenger } from '../src/automation/member-messenger.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * The Control Center's ON/OFF switches: per-gym AutomationSetting rows
 * behind GET/PATCH /automation/settings, enforced for real by
 * MemberMessenger.deliver() -- not a mock toggle that scanners ignore.
 */
describe('Automation settings (e2e)', () => {
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
    org = await registerOrg('Automation Settings Gym');
    other = await registerOrg('Automation Settings Other Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('lists every key enabled by default', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/settings'),
    ).expect(200);

    const settings = res.body.data as Array<{ key: string; enabled: boolean }>;
    const keys = settings.map((s) => s.key);
    for (const key of [
      'PAYMENT_OVERDUE_REMINDER',
      'MEMBERSHIP_RENEWAL_REMINDER',
      'INVOICE_DUE_REMINDER',
      'PT_EXPIRY_REMINDER',
      'MEMBER_INACTIVE_RECOVERY',
      'LEAD_FIRST_TOUCH',
      'LEAD_FOLLOWUP_REMINDER',
      'LOW_STOCK_ALERT',
      'BIRTHDAY_WISH',
      'MEMBERSHIP_POST_EXPIRY',
    ]) {
      expect(keys).toContain(key);
    }
    for (const setting of settings) {
      expect(setting.enabled).toBe(true);
    }
  });

  it('persists a toggle off and back on', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/MEMBERSHIP_RENEWAL_REMINDER')
        .send({ enabled: false }),
    ).expect(200);

    const row = await prisma.automationSetting.findUnique({
      where: {
        organizationId_key: {
          organizationId: org.organizationId,
          key: 'MEMBERSHIP_RENEWAL_REMINDER',
        },
      },
    });
    expect(row?.enabled).toBe(false);

    const listed = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/automation/settings'),
    ).expect(200);
    const renewal = (
      listed.body.data as Array<{ key: string; enabled: boolean }>
    ).find((s) => s.key === 'MEMBERSHIP_RENEWAL_REMINDER')!;
    expect(renewal.enabled).toBe(false);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/MEMBERSHIP_RENEWAL_REMINDER')
        .send({ enabled: true }),
    ).expect(200);
    expect(
      (
        await prisma.automationSetting.findUnique({
          where: {
            organizationId_key: {
              organizationId: org.organizationId,
              key: 'MEMBERSHIP_RENEWAL_REMINDER',
            },
          },
        })
      )?.enabled,
    ).toBe(true);
  });

  it('keeps one gym toggles away from another', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/PT_EXPIRY_REMINDER')
        .send({ enabled: false }),
    ).expect(200);

    // The other gym still sees its own defaults, not our switch.
    const theirs = await authed(other.accessToken)(
      request(app.getHttpServer()).get('/automation/settings'),
    ).expect(200);
    expect(
      (theirs.body.data as Array<{ key: string; enabled: boolean }>).find(
        (s) => s.key === 'PT_EXPIRY_REMINDER',
      )?.enabled,
    ).toBe(true);

    // And their write lands on their row, never ours.
    await authed(other.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/PT_EXPIRY_REMINDER')
        .send({ enabled: true }),
    ).expect(200);
    expect(
      (
        await prisma.automationSetting.findUnique({
          where: {
            organizationId_key: {
              organizationId: org.organizationId,
              key: 'PT_EXPIRY_REMINDER',
            },
          },
        })
      )?.enabled,
    ).toBe(false);
  });

  it('rejects bad quiet hours and bad channels', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/LEAD_FIRST_TOUCH')
        .send({ quietHoursStart: '25:00', quietHoursEnd: '06:00' }),
    ).expect(400);

    // Half a window is not a window.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/LEAD_FIRST_TOUCH')
        .send({ quietHoursStart: '22:00' }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/LEAD_FIRST_TOUCH')
        .send({ channelOverride: 'SMS' }),
    ).expect(400);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/NO_SUCH_AUTOMATION')
        .send({ enabled: false }),
    ).expect(400);

    // A full window with a valid channel stores fine.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .patch('/automation/settings/LEAD_FIRST_TOUCH')
        .send({
          quietHoursStart: '22:00',
          quietHoursEnd: '06:00',
          channelOverride: 'EMAIL',
          cooldownDays: 7,
        }),
    ).expect(200);
    const stored = await prisma.automationSetting.findUnique({
      where: {
        organizationId_key: {
          organizationId: org.organizationId,
          key: 'LEAD_FIRST_TOUCH',
        },
      },
    });
    expect(stored).toMatchObject({
      quietHoursStart: '22:00',
      quietHoursEnd: '06:00',
      channelOverride: 'EMAIL',
      cooldownDays: 7,
    });
  });

  it('skips delivery without sending when the key is disabled', async () => {
    const settings = app.get(AutomationSettingsService);
    await settings.update(org.organizationId, 'INVOICE_DUE_REMINDER', {
      enabled: false,
    });

    const messenger = app.get(MemberMessenger);
    const subjectId = `disabled-toggle-${Date.now()}`;
    const email = jest.fn(() => Promise.resolve({ status: 'SENT' }));
    const delivery = await messenger.deliver({
      organizationId: org.organizationId,
      key: 'INVOICE_DUE_REMINDER',
      subjectId,
      cooldownDays: 3,
      member: { id: 'member-id', email: 'member@example.com', phone: null },
      email,
      detail: { daysOverdue: 2 },
    });

    expect(delivery).toEqual({ outcome: 'SKIPPED', channel: null });
    expect(email).not.toHaveBeenCalled();
    const run = await prisma.automationRun.findFirst({
      where: {
        organizationId: org.organizationId,
        key: 'INVOICE_DUE_REMINDER',
        subjectId,
      },
    });
    expect(run?.status).toBe('SKIPPED');
    expect(run?.detail).toMatchObject({ disabled: true });
  });
});
