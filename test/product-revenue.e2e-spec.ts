import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Product sales at the counter are revenue. They never became Payment
 * rows, so the revenue screens left them out; returns now count against
 * them and a cancelled sale counts for nothing.
 */
describe('Product sales in revenue (e2e)', () => {
  let app: INestApplication;
  let gym: RegisteredAccount;
  let productId: string;

  const server = () => app.getHttpServer();
  const as = (token: string) => ({
    get: (url: string) =>
      request(server()).get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string) =>
      request(server()).post(url).set('Authorization', `Bearer ${token}`),
    patch: (url: string) =>
      request(server()).patch(url).set('Authorization', `Bearer ${token}`),
  });
  const owner = () => as(gym.accessToken);

  async function inr() {
    const res = await owner().get('/analytics/revenue').expect(200);
    return res.body.data.revenue.find(
      (r: { currency: string }) => r.currency === 'INR',
    ) as
      | {
          grossRevenue: string;
          productRevenue: string;
          refunded: string;
          netRevenue: string;
        }
      | undefined;
  }

  beforeAll(async () => {
    app = (await createTestApp()).app;
    const res = await request(server())
      .post('/auth/register')
      .send({
        organizationName: 'Product Revenue Gym',
        email: `product-revenue-${Date.now()}@example.com`,
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
    await owner()
      .patch('/organizations/current')
      .send({ currency: 'INR', timezone: 'Asia/Kolkata' })
      .expect(200);
    productId = (
      await owner()
        .post('/products')
        .send({ sku: `WHEY-${Date.now()}`, name: 'Whey 1kg', unitPrice: 2000 })
        .expect(201)
    ).body.data.id;
    await owner()
      .post(`/products/${productId}/stock-movements`)
      .send({ type: 'RESTOCK', quantity: 20, branchId: gym.branchId })
      .expect(201);
  });

  afterAll(async () => {
    await app?.close().catch(() => {});
  });

  it('counts a counter sale, nets its returns, and ignores a cancelled one', async () => {
    expect(await inr()).toBeUndefined();

    // 2 x 2000 with 400 off: 3600 taken.
    const sale = await owner()
      .post('/inventory/sales')
      .send({
        branchId: gym.branchId,
        discount: 400,
        items: [{ productId, quantity: 2, unitPrice: 2000 }],
      })
      .expect(201);
    let revenue = await inr();
    expect(revenue).toMatchObject({
      productRevenue: '3600.00',
      grossRevenue: '3600.00',
      netRevenue: '3600.00',
    });

    // One returned: 1800 of it (its share of the discount) goes back.
    await owner()
      .post(`/inventory/sales/${sale.body.data.id}/return`)
      .send({ items: [{ productId, quantity: 1 }] })
      .expect(201);
    revenue = await inr();
    expect(revenue).toMatchObject({
      productRevenue: '3600.00',
      refunded: '1800.00',
      netRevenue: '1800.00',
    });

    const cancelled = await owner()
      .post('/inventory/sales')
      .send({
        branchId: gym.branchId,
        items: [{ productId, quantity: 1, unitPrice: 2000 }],
      })
      .expect(201);
    await owner()
      .post(`/inventory/sales/${cancelled.body.data.id}/cancel`)
      .expect(201);
    revenue = await inr();
    expect(revenue?.productRevenue).toBe('3600.00');

    const trend = await owner()
      .get('/analytics/revenue/trend?months=1')
      .expect(200);
    expect(trend.body.data[0].revenue[0]).toMatchObject({
      currency: 'INR',
      productRevenue: '3600.00',
      netRevenue: '1800.00',
    });

    const summary = await owner().get('/analytics/revenue').expect(200);
    expect(
      summary.body.data.notComputable.map((n: { key: string }) => n.key),
    ).not.toContain('productRevenue');
  });
});
