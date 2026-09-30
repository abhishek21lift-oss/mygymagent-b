// MUST stay first -- see the helper.
import { restoreWhatsappWebTestEnv } from './utils/whatsapp-web-test-env';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MemberInactiveScanner } from '../src/automation/scanners/member-inactive.scanner';
import { MembershipRenewalScanner } from '../src/automation/scanners/membership-renewal.scanner';
import { PaymentOverdueScanner } from '../src/automation/scanners/payment-overdue.scanner';
import {
  InvoiceDunningScanner,
  dunningWindowFor,
} from '../src/automation/scanners/invoice-dunning.scanner';
import { PrismaService } from '../src/prisma/prisma.service';
import { WA_SOCKET_FACTORY } from '../src/whatsapp-web/whatsapp-web.types';
import { eventually, fakeWhatsapp } from './utils/fake-whatsapp';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The automation audit: member reminders going out on the gym's own
 * WhatsApp number, and the correctness fixes found on the way -- renewed
 * members, deleted members, suspended gyms, failed payments, missed
 * dunning days, and "we miss you" repeating forever.
 */
describe('Automations over WhatsApp, and the audit fixes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  const { factory, socketFor } = fakeWhatsapp();

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
    delete: (url: string) =>
      request(server()).delete(url).set('Authorization', `Bearer ${token}`),
  });

  async function register(name: string): Promise<RegisteredAccount> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `auto-wa-${suffix}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    const branches = await as(token).get('/branches').expect(200);
    return {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  let phoneSeq = 0;
  async function member(
    account: RegisteredAccount,
    extra: Record<string, unknown> = {},
  ) {
    phoneSeq += 1;
    const res = await as(account.accessToken)
      .post('/members')
      .send({
        primaryBranchId: account.branchId,
        firstName: 'Asha',
        lastName: `Verma${phoneSeq}`,
        phone: `98${String(Date.now()).slice(-6)}${String(phoneSeq).padStart(2, '0')}`,
        email: `asha-${Date.now()}-${phoneSeq}@example.com`,
        ...extra,
      })
      .expect(201);
    return res.body.data as { id: string; phone: string; email: string };
  }

  async function membership(
    account: RegisteredAccount,
    memberId: string,
    durationDays: number,
    price = 1999,
  ) {
    const plan = await as(account.accessToken)
      .post('/membership-plans')
      .send({ name: `Plan ${durationDays}d`, durationDays, price })
      .expect(201);
    const res = await as(account.accessToken)
      .post('/memberships')
      .send({ memberId, membershipPlanId: plan.body.data.id })
      .expect(201);
    return res.body.data as { id: string; endDate: string };
  }

  // Every new member is welcomed (see the welcome test); the reminder
  // tests look past that.
  const NOT_REMINDERS = ['welcome', 'welcome_email', 'payment.received'];
  const whatsappLogs = (memberId: string, include: string[] = []) =>
    prisma.messageLog.findMany({
      where: {
        memberId,
        channel: 'WHATSAPP',
        templateKey: {
          notIn: NOT_REMINDERS.filter((k) => !include.includes(k)),
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  const emailLogs = (memberId: string) =>
    prisma.messageLog.findMany({
      where: {
        memberId,
        channel: 'EMAIL',
        templateKey: { notIn: NOT_REMINDERS },
      },
    });
  const remindersFor = (memberId: string) =>
    prisma.messageLog.count({
      where: { memberId, templateKey: { notIn: NOT_REMINDERS } },
    });
  const sentTo = (phoneDigits: string) =>
    socketFor(gym.organizationId).sent.filter(
      (m) => m.jid.startsWith(phoneDigits) && !m.text.includes('welcome to'),
    );

  beforeAll(async () => {
    app = (
      await createTestApp((b) =>
        b.overrideProvider(WA_SOCKET_FACTORY).useValue(factory),
      )
    ).app;
    prisma = app.get(PrismaService);
    gym = await register('WhatsApp Automation Gym');
    await prisma.organization.update({
      where: { id: gym.organizationId },
      data: { currency: 'INR', timezone: 'Asia/Kolkata' },
    });
    // Link the gym's own number and send through it.
    await as(gym.accessToken)
      .post('/whatsapp-web/connect')
      .send({ acceptRisk: true })
      .expect(201);
    const socket = socketFor(gym.organizationId);
    socket.user = { id: '919800000009@s.whatsapp.net' };
    socket.emit('connection.update', { connection: 'open' });
    await eventually(
      () =>
        prisma.whatsappWebSession.findUniqueOrThrow({
          where: { organizationId: gym.organizationId },
        }),
      (s) => s.status === 'CONNECTED',
    );
    await as(gym.accessToken)
      .patch('/whatsapp-web/settings')
      .send({ useForSending: true })
      .expect(200);
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
    restoreWhatsappWebTestEnv();
  });

  describe('renewal reminders', () => {
    it('go on WhatsApp, not email, with a readable date -- once per stage', async () => {
      const m = await member(gym);
      const ms = await membership(gym, m.id, 5);
      const scanner = app.get(MembershipRenewalScanner);

      await scanner.scan();
      await scanner.scan();

      const logs = await whatsappLogs(m.id);
      expect(logs.map((l) => l.templateKey)).toEqual(['renewal.t7']);
      expect(await emailLogs(m.id)).toHaveLength(0);

      const digits = `91${m.phone}`;
      const [message] = await eventually(
        async () => sentTo(digits),
        (s) => s.length > 0,
      );
      const readable = new Intl.DateTimeFormat('en-IN', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'Asia/Kolkata',
      }).format(new Date(ms.endDate));
      expect(message.text).toContain(`membership ends on ${readable}`);
      expect(message.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
      expect(message.text).not.toContain('{{');
    });

    it('sends the next stage when fewer days are left', async () => {
      const m = await member(gym);
      const ms = await membership(gym, m.id, 5);
      await app.get(MembershipRenewalScanner).scan();
      // Two days later: the 3-day stage, once.
      await prisma.membership.update({
        where: { id: ms.id },
        data: { endDate: new Date(Date.now() + 2 * DAY) },
      });
      await app.get(MembershipRenewalScanner).scan();
      await app.get(MembershipRenewalScanner).scan();
      expect((await whatsappLogs(m.id)).map((l) => l.templateKey)).toEqual([
        'renewal.t7',
        'renewal.t3',
      ]);
    });

    it('fall back to email for a member with no phone', async () => {
      const m = await member(gym, { phone: undefined });
      await membership(gym, m.id, 5);
      await app.get(MembershipRenewalScanner).scan();
      expect(await whatsappLogs(m.id)).toHaveLength(0);
      expect(await emailLogs(m.id)).toHaveLength(1);
    });

    it('are not sent to a member who has already bought their next membership', async () => {
      const m = await member(gym);
      await membership(gym, m.id, 5);
      await membership(gym, m.id, 35);
      await app.get(MembershipRenewalScanner).scan();
      expect(await remindersFor(m.id)).toBe(0);
    });

    it('are not sent to a deleted member', async () => {
      const m = await member(gym);
      await membership(gym, m.id, 5);
      await as(gym.accessToken).delete(`/members/${m.id}`).expect(200);
      await app.get(MembershipRenewalScanner).scan();
      expect(await remindersFor(m.id)).toBe(0);
    });

    it('are not sent for a suspended gym', async () => {
      const other = await register('Suspended Gym');
      const m = await member(other);
      await membership(other, m.id, 5);
      await prisma.organization.update({
        where: { id: other.organizationId },
        data: { status: 'SUSPENDED' },
      });
      await app.get(MembershipRenewalScanner).scan();
      expect(await remindersFor(m.id)).toBe(0);
    });
  });

  describe('payment reminders', () => {
    it('treat a failed payment as unpaid, and remind on WhatsApp with the amount in rupees', async () => {
      const m = await member(gym);
      const ms = await membership(gym, m.id, 30, 2500);
      // The full price was "paid" -- by a card that was declined.
      await prisma.payment.create({
        data: {
          organizationId: gym.organizationId,
          branchId: gym.branchId,
          memberId: m.id,
          membershipId: ms.id,
          amount: 2500,
          currency: 'INR',
          method: 'CARD',
          status: 'FAILED',
        },
      });

      await app.get(PaymentOverdueScanner).scan();
      const [log] = await whatsappLogs(m.id);
      expect(log?.templateKey).toBe('payment.overdue');
      const [message] = await eventually(
        async () => sentTo(`91${m.phone}`),
        (s) => s.length > 0,
      );
      expect(message.text).toContain('₹2,500');
    });
  });

  describe('invoice reminders', () => {
    it('picks the latest window, catching up a missed day, and sends each window once', () => {
      expect(dunningWindowFor(-5)).toBeNull();
      expect(dunningWindowFor(-3)).toBe(-3);
      expect(dunningWindowFor(-1)).toBe(-3);
      expect(dunningWindowFor(0)).toBe(0);
      expect(dunningWindowFor(8)).toBe(7);
      expect(dunningWindowFor(11)).toBeNull();
    });

    it('still sends the final notice when the day it was due was missed, and marks the invoice overdue', async () => {
      const m = await member(gym);
      const invoice = await prisma.invoice.create({
        data: {
          organizationId: gym.organizationId,
          memberId: m.id,
          number: `INV-AUDIT-${Date.now()}`,
          status: 'ISSUED',
          subtotal: 1500,
          discountTotal: 0,
          taxTotal: 0,
          grandTotal: 1500,
          currency: 'INR',
          issuedAt: new Date(Date.now() - 20 * DAY),
          dueAt: new Date(Date.now() - 8 * DAY - 60_000),
        },
      });
      const scanner = app.get(InvoiceDunningScanner);
      await scanner.scan();
      await scanner.scan();

      const logs = await whatsappLogs(m.id);
      expect(logs.map((l) => l.templateKey)).toEqual(['invoice.final_notice']);
      const attempts = await prisma.dunningAttempt.findMany({
        where: { invoiceId: invoice.id },
      });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]).toMatchObject({
        channel: 'WHATSAPP',
        templateKey: 'invoice.final_notice',
      });
      expect(
        (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } }))
          .status,
      ).toBe('OVERDUE');
    });
  });

  describe('win-back', () => {
    it('is sent once per absence, not every fortnight forever', async () => {
      const m = await member(gym);
      await prisma.member.update({
        where: { id: m.id },
        data: { joinedAt: new Date(Date.now() - 90 * DAY) },
      });
      await prisma.memberConsent.create({
        data: {
          organizationId: gym.organizationId,
          memberId: m.id,
          type: 'MARKETING',
          granted: true,
        },
      });
      const scanner = app.get(MemberInactiveScanner);
      await scanner.scan();
      // A fortnight on: the old cooldown would have let it through again.
      await prisma.automationRun.updateMany({
        where: {
          organizationId: gym.organizationId,
          key: 'MEMBER_INACTIVE_RECOVERY',
          subjectId: m.id,
        },
        data: { createdAt: new Date(Date.now() - 15 * DAY) },
      });
      await scanner.scan();
      const runs = await prisma.automationRun.findMany({
        where: {
          organizationId: gym.organizationId,
          key: 'MEMBER_INACTIVE_RECOVERY',
          subjectId: m.id,
        },
      });
      expect(runs).toHaveLength(1);
      // Marketing never goes out from the gym's own number.
      expect(await whatsappLogs(m.id)).toHaveLength(0);
    });
  });

  describe('welcome and receipts', () => {
    it('welcomes a new member on WhatsApp', async () => {
      const m = await member(gym, { email: undefined });
      const logs = await eventually(
        () => whatsappLogs(m.id, ['welcome']),
        (l) => l.length > 0,
      );
      expect(logs[0].templateKey).toBe('welcome');
      const messages = await eventually(
        async () =>
          socketFor(gym.organizationId).sent.filter((x) =>
            x.jid.startsWith(`91${m.phone}`),
          ),
        (s) => s.length > 0,
      );
      expect(messages[0].text).toContain('welcome to WhatsApp Automation Gym');
    });

    it('sends a WhatsApp receipt for a payment taken at the desk', async () => {
      const m = await member(gym);
      await as(gym.accessToken)
        .post('/payments')
        .send({ memberId: m.id, amount: 1200, method: 'CASH' })
        .expect(201);
      const logs = await eventually(
        () => whatsappLogs(m.id, ['payment.received']),
        (l) => l.some((x) => x.templateKey === 'payment.received'),
      );
      expect(
        logs.find((x) => x.templateKey === 'payment.received'),
      ).toBeTruthy();
      const messages = await eventually(
        async () => sentTo(`91${m.phone}`),
        (s) => s.some((x) => x.text.includes('₹1,200')),
      );
      expect(
        messages.some((x) =>
          x.text.includes('we received your payment of ₹1,200'),
        ),
      ).toBe(true);
    });
  });

  describe('the automation screen', () => {
    it('says which reminders go on WhatsApp now', async () => {
      const res = await as(gym.accessToken).get('/automation').expect(200);
      const byKey = Object.fromEntries(
        (
          res.body.data.scanners as Array<{
            key: string;
            viaWhatsapp: boolean;
            channel: string;
          }>
        ).map((s) => [s.key, s]),
      );
      expect(byKey.MEMBERSHIP_RENEWAL_REMINDER.viaWhatsapp).toBe(true);
      expect(byKey.MEMBER_INACTIVE_RECOVERY.viaWhatsapp).toBe(false);
      expect(byKey.LEAD_FIRST_TOUCH.channel).toBe('whatsapp');
      expect(res.body.data.channels.whatsapp).toBe(true);
      // WhatsApp runs are recorded as `<membershipId>:whatsapp:t7`; they
      // still name the member in the recent list.
      const recent = res.body.data.recent as Array<{
        subjectId: string;
        subjectLabel: string | null;
      }>;
      const whatsappRun = recent.find((r) => r.subjectId.includes(':whatsapp'));
      expect(whatsappRun?.subjectLabel).toMatch(/Asha Verma\d+$/);
    });
  });
});
