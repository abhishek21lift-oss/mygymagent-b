import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Putting a payment that was recorded without its membership onto the
 * invoice it was meant for -- the only way such a payment ever reaches an
 * invoice.
 */
describe('Linking a payment to an invoice (e2e)', () => {
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

  async function member(firstName: string) {
    const res = await owner()
      .post('/members')
      .send({ primaryBranchId: gym.branchId, firstName, lastName: 'Link' })
      .expect(201);
    return res.body.data.id as string;
  }

  /** A sale and its auto-raised invoice. */
  async function sale(memberId: string) {
    const membership = await owner()
      .post('/memberships')
      .send({ memberId, membershipPlanId: planId })
      .expect(201);
    for (let attempt = 0; attempt < 50; attempt++) {
      const invoice = await prisma.invoice.findFirst({
        where: { membershipId: membership.body.data.id },
      });
      if (invoice) return { membershipId: membership.body.data.id, invoice };
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('No invoice raised');
  }

  /** A desk payment that names no membership. */
  async function loosePayment(memberId: string, amount: number) {
    const res = await owner()
      .post('/payments')
      .send({ memberId, amount, method: 'CASH' })
      .expect(201);
    return res.body.data.id as string;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    prisma = app.get(PrismaService);
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Invoice Link Gym',
        email: `invoice-link-${Date.now()}@example.com`,
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
      branchId: (await as(token).get('/branches').expect(200)).body.data
        .items[0].id,
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

  it('offers a loose payment and puts it on the invoice', async () => {
    const memberId = await member('Loose');
    const { membershipId, invoice } = await sale(memberId);
    const paymentId = await loosePayment(memberId, 400);

    const offered = await owner()
      .get(`/invoices/${invoice.id}/linkable-payments`)
      .expect(200);
    expect(offered.body.data).toEqual([
      expect.objectContaining({ id: paymentId, unallocated: '400.00' }),
    ]);

    const linked = await owner()
      .post(`/invoices/${invoice.id}/payments`)
      .send({ paymentId })
      .expect(201);
    expect(linked.body.data.status).toBe('PART_PAID');
    expect(linked.body.data.outstanding).toBe('600.00');

    // The payment now counts on the member's balance too.
    const payment = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });
    expect(payment.membershipId).toBe(membershipId);
    const billing = await owner()
      .get(`/members/${memberId}/membership-billing`)
      .expect(200);
    expect(Number(billing.body.data.outstandingBalance)).toBe(600);

    // Once on, it is not offered again and can't be added twice.
    const again = await owner()
      .get(`/invoices/${invoice.id}/linkable-payments`)
      .expect(200);
    expect(again.body.data).toEqual([]);
    await owner()
      .post(`/invoices/${invoice.id}/payments`)
      .send({ paymentId })
      .expect(409);
  });

  it('takes only what the invoice owes and leaves the rest for another', async () => {
    const memberId = await member('Overpaid');
    const first = await sale(memberId);
    const second = await sale(memberId);
    const paymentId = await loosePayment(memberId, 1500);

    const onFirst = await owner()
      .post(`/invoices/${first.invoice.id}/payments`)
      .send({ paymentId })
      .expect(201);
    expect(onFirst.body.data.status).toBe('PAID');

    const offered = await owner()
      .get(`/invoices/${second.invoice.id}/linkable-payments`)
      .expect(200);
    expect(offered.body.data[0]).toMatchObject({
      id: paymentId,
      unallocated: '500.00',
    });
    const onSecond = await owner()
      .post(`/invoices/${second.invoice.id}/payments`)
      .send({ paymentId })
      .expect(201);
    expect(onSecond.body.data.outstanding).toBe('500.00');
  });

  it("refuses another member's payment and a paid invoice", async () => {
    const memberId = await member('Owner');
    const { invoice } = await sale(memberId);
    const stranger = await member('Stranger');
    const theirs = await loosePayment(stranger, 1000);
    await owner()
      .post(`/invoices/${invoice.id}/payments`)
      .send({ paymentId: theirs })
      .expect(400);

    const mine = await loosePayment(memberId, 1000);
    await owner()
      .post(`/invoices/${invoice.id}/payments`)
      .send({ paymentId: mine })
      .expect(201);
    const extra = await loosePayment(memberId, 100);
    await owner()
      .post(`/invoices/${invoice.id}/payments`)
      .send({ paymentId: extra })
      .expect(400);
  });
});
