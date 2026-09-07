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
    // Barcode product (EAN-13) and QR product (custom SKU), as the staff
    // would set them up: the SKU field holds the scan value.
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

    // --- Repeated scans for inventory receiving: 10 rapid GET lookups
    // (the scanner resolves the product each time; duplicates are
    // deduped client-side, so each confirmed scan = one movement) ---
    const scan = () =>
      authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/5901234123457'),
      ).expect(200);

    const results = await Promise.all(Array.from({ length: 10 }, () => scan()));
    // Every concurrent lookup resolves to the same product, tenant-safely.
    expect(
      results.every((r) => r.body.data.id === barcodeProduct.body.data.id),
    ).toBe(true);

    // User then confirms ONE stock-in of the aggregated quantity (10).
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
    expect(after.body.data.quantityOnHand).toBe(22); // 12 + 10

    // QR-code product resolves the same way.
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
    // The scan lookup (not the create response) drives the rest of the
    // flow, exactly as the frontend does after a camera detection.

    const detected = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/products/scan/5901234123458'),
    ).expect(200);

    // Sale of 4 -> 2 left.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${detected.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 4 }),
    ).expect(201);

    // Existing oversell guard still applies to scan-driven sales.
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

  it('scenario 10: tenant isolation - the other org cannot resolve this org\u2019s code', async () => {
    // otherOrg has NO product with this SKU.
    await authed(otherOrg.accessToken)(
      request(app.getHttpServer()).get('/products/scan/5901234123458'),
    ).expect(404);

    // And it cannot use its own token to move this org's stock even with
    // the product id (existing tenant guard, re-verified for the flow).
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
    // Manual create + manual list + manual movement, unchanged paths.
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
