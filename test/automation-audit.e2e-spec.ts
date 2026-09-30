import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { InvoiceDunningScanner } from '../src/automation/scanners/invoice-dunning.scanner';
import { PaymentOverdueScanner } from '../src/automation/scanners/payment-overdue.scanner';
import { PlatformBillingService } from '../src/platform-billing/platform-billing.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Automations the audit found reaching the wrong people or none: staff
 * notifications in members' bells, member logins counted as staff, a
 * refunded invoice never chased, and one debt chased twice.
 */
describe('Automation audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let planId: string;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(gym.accessToken);

  async function until<T>(read: () => Promise<T | null>): Promise<T> {
    for (let attempt = 0; attempt < 50; attempt++) {
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Timed out waiting');
  }

  async function newMember(firstName: string, email?: string) {
    const res = await owner()
      .post('/members')
      .send({
        primaryBranchId: gym.branchId,
        firstName,
        lastName: 'Audit',
        ...(email ? { email } : {}),
      })
      .expect(201);
    return res.body.data.id as string;
  }

  /** A member with a live portal login. */
  async function portalMember(firstName: string) {
    const memberId = await newMember(
      firstName,
      `${firstName.toLowerCase()}-${Date.now()}@example.com`,
    );
    await owner().post(`/portal/enable/${memberId}`).expect(201);
    const member = await prisma.member.findUniqueOrThrow({
      where: { id: memberId },
    });
    await prisma.user.update({
      where: { id: member.userId! },
      data: { status: 'ACTIVE' },
    });
    return { memberId, userId: member.userId! };
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Automation Audit Gym',
        email: `automation-audit-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: (
        await request(server())
          .get('/branches')
          .set('Authorization', `Bearer ${token}`)
          .expect(200)
      ).body.data.items[0].id,
    };
    planId = (
      await owner()
        .post('/membership-plans')
        .send({ name: 'Monthly', durationDays: 30, price: 1000 })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  describe('member portal logins are not staff', () => {
    it("never get the gym's staff notifications", async () => {
      const { userId } = await portalMember('Bell');
      const payer = await newMember('Payer');
      const payment = await owner()
        .post('/payments')
        .send({ memberId: payer, amount: 500, method: 'CASH' })
        .expect(201);

      // The owner's copy proves the fan-out ran.
      await until(() =>
        prisma.notification.findFirst({
          where: { userId: gym.userId, entityId: payment.body.data.id },
        }),
      );
      const leaked = await prisma.notification.count({
        where: { userId, organizationId: gym.organizationId },
      });
      expect(leaked).toBe(0);
    });

    it('are left out of the staff list and the staff count', async () => {
      const { userId } = await portalMember('Counted');
      const list = await owner().get('/users?pageSize=100').expect(200);
      const ids = list.body.data.items.map((u: { id: string }) => u.id);
      expect(ids).toContain(gym.userId);
      expect(ids).not.toContain(userId);

      const usage = await app
        .get(PlatformBillingService)
        .usage(gym.organizationId);
      expect(usage.usage.staff).toBe(1);
    });
  });

  describe('reminders about money', () => {
    it('chases an invoice a refund reopened', async () => {
      const memberId = await newMember(
        'Refunded',
        `refunded-${Date.now()}@example.com`,
      );
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId, initialPayment: 1000 })
        .expect(201);
      const invoice = await until(() =>
        prisma.invoice.findFirst({
          where: { membershipId: sale.body.data.id, status: 'PAID' },
        }),
      );
      const payment = await prisma.payment.findFirstOrThrow({
        where: { membershipId: sale.body.data.id },
      });
      await owner()
        .post(`/payments/${payment.id}/refund`)
        .send({ reason: 'Moved away' })
        .expect(201);
      await until(() =>
        prisma.invoice.findFirst({
          where: { id: invoice.id, status: 'ISSUED' },
        }),
      );
      // Due a minute ago: today's window, whatever the clock does next.
      await prisma.invoice.update({
        where: { id: invoice.id },
        data: { dueAt: new Date(Date.now() - 60_000) },
      });

      await app.get(InvoiceDunningScanner).scan();

      const run = await prisma.automationRun.findFirst({
        where: {
          organizationId: gym.organizationId,
          key: 'INVOICE_DUE_REMINDER',
          subjectId: `${invoice.id}:w0`,
        },
      });
      expect(run).not.toBeNull();
    });

    it('chases one debt once: invoiced memberships are left to invoice reminders', async () => {
      const invoiced = await newMember(
        'Invoiced',
        `invoiced-${Date.now()}@example.com`,
      );
      const withInvoice = await owner()
        .post('/memberships')
        .send({ memberId: invoiced, membershipPlanId: planId })
        .expect(201);
      await until(() =>
        prisma.invoice.findFirst({
          where: { membershipId: withInvoice.body.data.id },
        }),
      );

      const imported = await newMember(
        'Imported',
        `imported-${Date.now()}@example.com`,
      );
      const withoutInvoice = await owner()
        .post('/memberships')
        .send({ memberId: imported, membershipPlanId: planId })
        .expect(201);
      // As an imported membership has none.
      await until(() =>
        prisma.invoice.findFirst({
          where: { membershipId: withoutInvoice.body.data.id },
        }),
      );
      await prisma.invoice.deleteMany({
        where: { membershipId: withoutInvoice.body.data.id },
      });

      await app.get(PaymentOverdueScanner).scan();

      const runsFor = (membershipId: string) =>
        prisma.automationRun.count({
          where: {
            organizationId: gym.organizationId,
            key: 'PAYMENT_OVERDUE_REMINDER',
            subjectId: { startsWith: membershipId },
          },
        });
      expect(await runsFor(withInvoice.body.data.id)).toBe(0);
      expect(await runsFor(withoutInvoice.body.data.id)).toBe(1);
    });
  });
});
