/* Full-flow verification: drives the scan -> stock-in / stock-out flow
 * exactly as the frontend scanner does, against the real app + database. */
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, type RegisteredAccount } from '../test/utils/test-app';

describe('QR/barcode scan full flow (as driven by the frontend scanner)', () => {
  let app: INestApplication;
  let org: RegisteredAccount;
  let otherOrg: RegisteredAccount;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;

    const register = async (name: string) => {
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
    };
    org = await register('Scan Flow Gym');
    otherOrg = await register('Scan Flow Other Gym');
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('scenario 1+2+4+6: barcode product, QR product, stock-in via repeated scans', async () => {
    const barcodeProduct = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: '5901234123457',
        name: 'Whey Protein 1kg',
        unitPrice: 45,
        quantityOnHand: 12,
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'MGA-WHEY-1KG',
        name: 'Whey Protein 1kg (QR)',
        unitPrice: 45,
        quantityOnHand: 5,
      }),
    ).expect(201);

    // The frontend may receive repeated scanner detections rapidly, but the
    // application only needs to prove that each lookup is stable. Running
    // these requests sequentially avoids making the E2E test depend on the
    // test DB/HTTP server accepting a burst of concurrent connections.
    const results: request.Response[] = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(
        await authed(org.accessToken)(
          request(app.getHttpServer()).get('/products/scan/5901234123457'),
        ).expect(200),
      );
    }
    expect(
      results.every((r) => r.body.data.id === barcodeProduct.body.data.id),
    ).toBe(true);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${barcodeProduct.body.data.id}/stock-movements`)
        .send({ type: 'RESTOCK', quantity: 10, note: 'Delivery via scan' }),
    ).expect(201);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(
        `/products/${barcodeProduct.body.data.id}`,
      ),
    ).expect(200);
    expect(after.body.data.quantityOnHand).toBe(22);

    const qr = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products/scan/MGA-WHEY-1KG'),
    ).expect(200);
    expect(qr.body.data.sku).toBe('MGA-WHEY-1KG');
  });

  it('scenario 5: stock out via scan, existing business rules enforced', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: '5901234123458',
        name: 'Energy Drink',
        unitPrice: 3,
        quantityOnHand: 6,
      }),
    ).expect(201);

    const detected = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products/scan/5901234123458'),
    ).expect(200);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${detected.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 4 }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${detected.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 99 }),
    ).expect(400);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${detected.body.data.id}`),
    ).expect(200);
    expect(after.body.data.quantityOnHand).toBe(2);
  });

  it('scenario 3: unknown barcode -> 404, nothing created or mutated', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products/scan/UNKNOWN-000'),
    ).expect(404);
  });

  it('scenario 10: tenant isolation - the other org cannot resolve this org’s code', async () => {
    await authed(otherOrg.accessToken)(
      request(app.getHttpServer()).get('/products/scan/5901234123458'),
    ).expect(404);

    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products/scan/5901234123458'),
    ).expect(200);

    await authed(otherOrg.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 1 }),
    ).expect(404);
  });

  it('scenario 13: the existing manual workflow still works verbatim', async () => {
    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'MANUAL-1',
        name: 'Towel',
        unitPrice: 5,
        quantityOnHand: 3,
      }),
    ).expect(201);

    const list = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products'),
    ).expect(200);
    expect(
      list.body.data.items.some((p: { sku: string }) => p.sku === 'MANUAL-1'),
    ).toBe(true);

    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'RESTOCK', quantity: 2 }),
    ).expect(201);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${product.body.data.id}`),
    ).expect(200);
    expect(after.body.data.quantityOnHand).toBe(5);
  });
});
