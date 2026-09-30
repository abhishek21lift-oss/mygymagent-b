import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { MembershipStatusScanner } from '../src/automation/scanners/membership-status.scanner';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

const DAY = 24 * 60 * 60 * 1000;

/**
 * The money paths the audit found broken: invoices that never learned a
 * desk payment settled them, refunds invoices never saw, renewals that
 * cost nothing, plan changes that charged twice, memberships that never
 * expired and freezes that never ended.
 */
describe('Money audit (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let gym: RegisteredAccount;
  let planId: string;
  let bigPlanId: string;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(gym.accessToken);

  /** The auto-raised invoice lands after the response (post-commit
   * listener), so wait for it to reach the expected state. */
  async function invoiceOf(
    membershipId: string,
    expect: (invoice: { status: string }) => boolean = () => true,
  ) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const invoice = await prisma.invoice.findFirst({
        where: { membershipId },
        include: { paymentLinks: true },
      });
      if (invoice && expect(invoice)) return invoice;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`No matching invoice for membership ${membershipId}`);
  }

  async function newMember(firstName: string): Promise<string> {
    const res = await owner()
      .post('/members')
      .send({ primaryBranchId: gym.branchId, firstName, lastName: 'Audit' })
      .expect(201);
    return res.body.data.id;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Money Audit Gym',
        email: `money-audit-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Gym',
      })
      .expect(201);
    const token = res.body.data.accessToken;
    const branches = await request(server())
      .get('/branches')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    gym = {
      accessToken: token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
    await owner()
      .patch('/organizations/current')
      .send({ currency: 'INR' })
      .expect(200);
    planId = (
      await owner()
        .post('/membership-plans')
        .send({
          name: 'Monthly',
          durationDays: 30,
          price: 1000,
          maxFreezeDays: 30,
        })
        .expect(201)
    ).body.data.id;
    bigPlanId = (
      await owner()
        .post('/membership-plans')
        .send({ name: 'Monthly Plus', durationDays: 30, price: 2000 })
        .expect(201)
    ).body.data.id;
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  describe('invoices settle from desk payments', () => {
    it('marks the invoice paid when the sale was paid in full', async () => {
      const memberId = await newMember('Paid');
      const sale = await owner()
        .post('/memberships')
        .send({
          memberId,
          membershipPlanId: planId,
          discount: 100,
          initialPayment: 900,
          paymentMethod: 'UPI',
        })
        .expect(201);
      const invoice = await invoiceOf(
        sale.body.data.id,
        (i) => i.status === 'PAID',
      );
      // What was sold: 1000 list, 100 off.
      expect(Number(invoice.subtotal)).toBe(1000);
      expect(Number(invoice.grandTotal)).toBe(900);
      expect(invoice.paymentLinks).toHaveLength(1);

      const payment = await prisma.payment.findFirstOrThrow({
        where: { membershipId: sale.body.data.id },
      });
      expect(payment.branchId).toBe(gym.branchId);
      expect(payment.currency).toBe('INR');
    });

    it('settles a later desk payment into the open invoice, and reopens it on refund', async () => {
      const memberId = await newMember('Later');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      const membershipId = sale.body.data.id;
      await invoiceOf(membershipId, (i) => i.status === 'ISSUED');

      await owner()
        .post('/payments')
        .send({ memberId, membershipId, amount: 400, method: 'CASH' })
        .expect(201);
      await invoiceOf(membershipId, (i) => i.status === 'PART_PAID');
      const rest = await owner()
        .post('/payments')
        .send({ memberId, membershipId, amount: 600, method: 'CASH' })
        .expect(201);
      await invoiceOf(membershipId, (i) => i.status === 'PAID');

      // Money given back is owed again.
      await owner()
        .post(`/payments/${rest.body.data.id}/refund`)
        .send({ amount: 600, reason: 'Changed mind' })
        .expect(201);
      const reopened = await invoiceOf(membershipId);
      expect(reopened.status).toBe('PART_PAID');
      expect(reopened.paidAt).toBeNull();
    });

    it('refuses to refund a failed payment', async () => {
      const memberId = await newMember('Declined');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      const failed = await owner()
        .post(`/memberships/${sale.body.data.id}/payment-failed`)
        .send({ amount: 1000, reason: 'Card declined' })
        .expect(201);
      await owner()
        .post(`/payments/${failed.body.data.id}/refund`)
        .send({})
        .expect(400);
    });
  });

  describe('discounts', () => {
    it.each([
      [{ discount: 1500 }, /more than the plan price/],
      [{ discount: -10 }, /discount/],
      [{ initialPayment: -5 }, /initialPayment/],
    ])('refuses %j', async (body, message) => {
      const memberId = await newMember('Discount');
      const res = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId, ...body })
        .expect(400);
      expect(JSON.stringify(res.body)).toMatch(message);
    });
  });

  describe('renewal', () => {
    it('queues a paid next term instead of extending for free', async () => {
      const memberId = await newMember('Renewer');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      const renewed = await owner()
        .post(`/memberships/${sale.body.data.id}/renew`)
        .send({})
        .expect(201);
      expect(renewed.body.data.id).not.toBe(sale.body.data.id);
      expect(renewed.body.data.startDate).toBe(sale.body.data.endDate);
      expect(renewed.body.data.previousMembershipId).toBe(sale.body.data.id);
      expect(Number(renewed.body.data.price)).toBe(1000);
      const invoice = await invoiceOf(renewed.body.data.id);
      expect(Number(invoice.grandTotal)).toBe(1000);

      // The old term is untouched.
      const old = await prisma.membership.findUniqueOrThrow({
        where: { id: sale.body.data.id },
      });
      expect(old.endDate.toISOString()).toBe(sale.body.data.endDate);

      // Renewing the same term twice would stack two paid terms on one date.
      await owner()
        .post(`/memberships/${sale.body.data.id}/renew`)
        .send({})
        .expect(400);
    });
  });

  describe('plan change', () => {
    it('charges the new plan less the unused, paid share of the old one', async () => {
      const memberId = await newMember('Upgrader');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId, initialPayment: 1000 })
        .expect(201);
      // Halfway through the term.
      await prisma.membership.update({
        where: { id: sale.body.data.id },
        data: {
          startDate: new Date(Date.now() - 15 * DAY),
          endDate: new Date(Date.now() + 15 * DAY),
        },
      });

      const changed = await owner()
        .post(`/memberships/${sale.body.data.id}/change-plan`)
        .send({ membershipPlanId: bigPlanId })
        .expect(201);
      expect(Number(changed.body.data.credit)).toBeCloseTo(500, 0);
      expect(Number(changed.body.data.amountDue)).toBeCloseTo(1500, 0);
      const next = changed.body.data.newMembership;
      expect(Number(next.price)).toBeCloseTo(1500, 0);
      expect(Number(next.price) + Number(next.discount)).toBe(2000);

      const invoice = await invoiceOf(next.id);
      expect(Number(invoice.subtotal)).toBe(2000);
      expect(Number(invoice.grandTotal)).toBeCloseTo(1500, 0);

      // Owed: the old term's 1000 (all paid) plus the new term's 1500.
      const billing = await owner()
        .get(`/members/${memberId}/membership-billing`)
        .expect(200);
      expect(Number(billing.body.data.outstandingBalance)).toBeCloseTo(1500, 0);
    });

    it('gives no credit for a term that was never paid', async () => {
      const memberId = await newMember('Unpaid');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      const changed = await owner()
        .post(`/memberships/${sale.body.data.id}/change-plan`)
        .send({ membershipPlanId: bigPlanId })
        .expect(201);
      expect(changed.body.data.credit).toBe('0.00');
      expect(changed.body.data.amountDue).toBe('2000.00');
    });

    it('refuses a payment method that does not exist', async () => {
      const memberId = await newMember('Method');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await owner()
        .post(`/memberships/${sale.body.data.id}/change-plan`)
        .send({ membershipPlanId: bigPlanId, paymentMethod: 'BITCOIN' })
        .expect(400);
    });
  });

  describe('member balance', () => {
    it('counts a discounted price once and waives a cancelled, unpaid term', async () => {
      const memberId = await newMember('Balance');
      await owner()
        .post('/memberships')
        .send({
          memberId,
          membershipPlanId: planId,
          discount: 200,
          initialPayment: 300,
        })
        .expect(201);
      const cancelled = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await owner()
        .post(`/memberships/${cancelled.body.data.id}/cancel`)
        .send({ reason: 'Moved away' })
        .expect(201);

      const billing = await owner()
        .get(`/members/${memberId}/membership-billing`)
        .expect(200);
      // 800 owed on the first, 300 paid; the cancelled one owes nothing.
      expect(Number(billing.body.data.totalDue)).toBe(800);
      expect(Number(billing.body.data.outstandingBalance)).toBe(500);

      const overview = await owner()
        .get(`/members/overview?memberId=${memberId}`)
        .expect(200);
      expect(Number(overview.body.data.finance.outstandingBalance)).toBe(500);
    });
  });

  describe('membership status over time', () => {
    it('expires ended memberships and ends freezes on the booked day', async () => {
      const scanner = app.get(MembershipStatusScanner);
      const memberId = await newMember('Timeline');
      const ended = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await prisma.membership.update({
        where: { id: ended.body.data.id },
        data: {
          startDate: new Date(Date.now() - 40 * DAY),
          endDate: new Date(Date.now() - 10 * DAY),
        },
      });

      const frozen = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await owner()
        .post(`/memberships/${frozen.body.data.id}/freeze`)
        .send({ days: 5 })
        .expect(201);
      // The freeze began 20 days ago and was booked for 5.
      const before = await prisma.membership.update({
        where: { id: frozen.body.data.id },
        data: {
          freezeStartDate: new Date(Date.now() - 20 * DAY),
          freezeEndDate: new Date(Date.now() - 15 * DAY),
        },
      });

      const result = await scanner.scan();
      expect(result.expired).toBeGreaterThanOrEqual(1);
      expect(result.resumed).toBeGreaterThanOrEqual(1);

      const nowEnded = await prisma.membership.findUniqueOrThrow({
        where: { id: ended.body.data.id },
      });
      expect(nowEnded.status).toBe('EXPIRED');

      const resumed = await prisma.membership.findUniqueOrThrow({
        where: { id: frozen.body.data.id },
      });
      expect(resumed.status).toBe('ACTIVE');
      expect(resumed.freezeStartDate).toBeNull();
      expect(resumed.totalFreezeDaysUsed).toBe(5);
      expect(resumed.endDate.getTime() - before.endDate.getTime()).toBe(
        5 * DAY,
      );

      // A second pass changes nothing.
      const again = await scanner.scan();
      const unchanged = await prisma.membership.findUniqueOrThrow({
        where: { id: frozen.body.data.id },
      });
      expect(unchanged.endDate).toEqual(resumed.endDate);
      expect(again.resumed).toBe(0);
    });

    it('credits no more than the booked freeze when resumed late by hand', async () => {
      const memberId = await newMember('LateResume');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await owner()
        .post(`/memberships/${sale.body.data.id}/freeze`)
        .send({ days: 5 })
        .expect(201);
      const before = await prisma.membership.update({
        where: { id: sale.body.data.id },
        data: {
          freezeStartDate: new Date(Date.now() - 20 * DAY),
          freezeEndDate: new Date(Date.now() - 15 * DAY),
        },
      });
      const res = await owner()
        .post(`/memberships/${sale.body.data.id}/resume`)
        .expect(201);
      expect(res.body.data.totalFreezeDaysUsed).toBe(5);
      expect(
        new Date(res.body.data.endDate).getTime() - before.endDate.getTime(),
      ).toBe(5 * DAY);
    });
  });

  describe('currency and revenue', () => {
    it("records an expense in the gym's currency when none is sent", async () => {
      const res = await owner()
        .post('/expenses')
        .send({ category: 'rent', amount: 25000 })
        .expect(201);
      expect(res.body.data.currency).toBe('INR');
    });

    it('never counts a failed payment as revenue', async () => {
      const before = await owner().get('/analytics/revenue').expect(200);
      const gross = (body: {
        data: { revenue: { currency: string; grossRevenue: string }[] };
      }) =>
        Number(
          body.data.revenue.find((r) => r.currency === 'INR')?.grossRevenue ??
            0,
        );

      const memberId = await newMember('Revenue');
      const sale = await owner()
        .post('/memberships')
        .send({ memberId, membershipPlanId: planId })
        .expect(201);
      await owner()
        .post(`/memberships/${sale.body.data.id}/payment-failed`)
        .send({ amount: 1000, reason: 'Card declined' })
        .expect(201);

      const after = await owner().get('/analytics/revenue').expect(200);
      expect(gross(after.body)).toBe(gross(before.body));
    });
  });
});
