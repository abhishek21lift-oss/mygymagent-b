import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

describe('Inventory (e2e)', () => {
  let app: INestApplication;
  let events: EventEmitter2;
  let org: RegisteredAccount;

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
    events = app.get(EventEmitter2);
    org = await registerOrg('Inventory Test Gym');
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  it('rejects a duplicate SKU within the same org', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'DUPE-1',
        name: 'Protein Shake',
        unitPrice: 4.5,
      }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'DUPE-1',
        name: 'A different product, same SKU',
        unitPrice: 5,
      }),
    ).expect(409);
  });

  it('creates a product, restocks it, sells from it, and rejects overselling', async () => {
    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'SHAKE-1',
        name: 'Vanilla Whey',
        category: 'Supplements',
        unitPrice: 3.5,
        costPrice: 1.75,
        quantityOnHand: 0,
        reorderLevel: 5,
      }),
    ).expect(201);
    expect(product.body.data.quantityOnHand).toBe(0);

    const restock = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'RESTOCK', quantity: 20, note: 'Initial delivery' }),
    ).expect(201);
    expect(restock.body.data.quantity).toBe(20);

    const afterRestock = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${product.body.data.id}`),
    ).expect(200);
    expect(afterRestock.body.data.quantityOnHand).toBe(20);

    // Selling more than is on hand is rejected, and stock is unchanged.
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 999 }),
    ).expect(400);

    const sale = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 15 }),
    ).expect(201);
    expect(sale.body.data.quantity).toBe(-15);

    const afterSale = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${product.body.data.id}`),
    ).expect(200);
    expect(afterSale.body.data.quantityOnHand).toBe(5);

    const movements = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/stock-movements')
        .query({ productId: product.body.data.id }),
    ).expect(200);
    expect(movements.body.data.items).toHaveLength(2);
  });

  it('emits inventory.low once quantityOnHand drops to the reorder level', async () => {
    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'LOWSTOCK-1',
        name: 'Creatine',
        unitPrice: 20,
        quantityOnHand: 10,
        reorderLevel: 5,
      }),
    ).expect(201);

    const received: unknown[] = [];
    const listener = (payload: unknown) => received.push(payload);
    events.on('inventory.low', listener);

    try {
      // Drops to 5, which is <= reorderLevel of 5 -> should fire.
      await authed(org.accessToken)(
        request(app.getHttpServer())
          .post(`/products/${product.body.data.id}/stock-movements`)
          .send({ type: 'SALE', quantity: 5 }),
      ).expect(201);
    } finally {
      events.off('inventory.low', listener);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      organizationId: org.organizationId,
      productId: product.body.data.id,
      quantityOnHand: 5,
      reorderLevel: 5,
    });
  });

  it('supports a negative ADJUSTMENT to correct a miscount', async () => {
    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'ADJUST-1',
        name: 'Shaker Bottle',
        unitPrice: 8,
        quantityOnHand: 10,
      }),
    ).expect(201);

    const adjustment = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .send({ type: 'ADJUSTMENT', quantity: -3, note: 'Recount correction' }),
    ).expect(201);
    expect(adjustment.body.data.quantity).toBe(-3);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${product.body.data.id}`),
    ).expect(200);
    expect(after.body.data.quantityOnHand).toBe(7);
  });

  it('never oversells under concurrent SALE requests against the last unit (regression for the read-then-write race)', async () => {
    // Before the fix, StockMovementsService.record() read
    // quantityOnHand, computed newQuantity, and only *then* opened a
    // transaction to write it -- two concurrent SALEs against 1 unit
    // on hand could both read 1, both pass the `>= 0` check, and both
    // decrement, driving stock to -1. The fix moves the guard into the
    // update's own WHERE clause so it's evaluated atomically by
    // Postgres, not by application code racing a stale read.
    const product = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/products').send({
        sku: 'RACE-1',
        name: 'Last Unit Standing',
        unitPrice: 10,
        quantityOnHand: 1,
      }),
    ).expect(201);

    const attempt = () =>
      request(app.getHttpServer())
        .post(`/products/${product.body.data.id}/stock-movements`)
        .set('Authorization', `Bearer ${org.accessToken}`)
        .send({ type: 'SALE', quantity: 1 });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);

    const after = await authed(org.accessToken)(
      request(app.getHttpServer()).get(`/products/${product.body.data.id}`),
    ).expect(200);
    expect(after.body.data.quantityOnHand).toBe(0);
  });

  it('rejects a stock movement referencing a product that does not exist', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/products/00000000-0000-0000-0000-000000000000/stock-movements')
        .send({ type: 'RESTOCK', quantity: 10 }),
    ).expect(404);
  });

  describe('QR/barcode product scan lookup (GET /products/scan/:code)', () => {
    it('resolves an exact SKU scan to this org\u2019s product', async () => {
      const product = await authed(org.accessToken)(
        request(app.getHttpServer()).post('/products').send({
          sku: 'WHEY-1KG',
          name: 'Whey Protein 1kg',
          unitPrice: 45,
          quantityOnHand: 12,
        }),
      ).expect(201);

      const scan = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/WHEY-1KG'),
      ).expect(200);
      expect(scan.body.data.id).toBe(product.body.data.id);
      expect(scan.body.data.name).toBe('Whey Protein 1kg');
      expect(scan.body.data.quantityOnHand).toBe(12);
    });

    it('resolves an EAN-13 numeric code, including a leading zero lost to scanner numeric coercion', async () => {
      // A real EAN-13 with a leading zero. Some scanners/devices emit the
      // 12-digit tail when the code is parsed as a number.
      await authed(org.accessToken)(
        request(app.getHttpServer()).post('/products').send({
          sku: '0031234567890',
          name: 'Energy Bar',
          unitPrice: 2.5,
        }),
      ).expect(201);

      const exact = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/0031234567890'),
      ).expect(200);
      expect(exact.body.data.sku).toBe('0031234567890');

      // The leading-zero-lost variant still resolves.
      const coerced = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/031234567890'),
      ).expect(200);
      expect(coerced.body.data.sku).toBe('0031234567890');
    });

    it('returns 404 for an unknown code, without creating anything', async () => {
      await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/NO-SUCH-CODE'),
      ).expect(404);

      // No product was auto-created for the unknown code.
      const list = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products'),
      ).expect(200);
      expect(
        list.body.data.items.some(
          (p: { sku: string }) => p.sku === 'NO-SUCH-CODE',
        ),
      ).toBe(false);
    });

    it('never resolves another organization\u2019s product with the same SKU', async () => {
      const other = await registerOrg('Scan Tenant Isolation Gym');

      // Both orgs have a product with the SAME scan code.
      await authed(org.accessToken)(
        request(app.getHttpServer()).post('/products').send({
          sku: 'SHARED-CODE',
          name: 'Owner org product',
          unitPrice: 1,
        }),
      ).expect(201);
      const otherProduct = await authed(other.accessToken)(
        request(app.getHttpServer()).post('/products').send({
          sku: 'SHARED-CODE',
          name: 'Other org product',
          unitPrice: 2,
        }),
      ).expect(201);

      // Each org's scan resolves only to its own product.
      const mine = await authed(org.accessToken)(
        request(app.getHttpServer()).get('/products/scan/SHARED-CODE'),
      ).expect(200);
      expect(mine.body.data.id).not.toBe(otherProduct.body.data.id);
      expect(mine.body.data.name).toBe('Owner org product');

      const theirs = await authed(other.accessToken)(
        request(app.getHttpServer()).get('/products/scan/SHARED-CODE'),
      ).expect(200);
      expect(theirs.body.data.id).toBe(otherProduct.body.data.id);
    });

    it('rejects an unauthenticated caller', async () => {
      await request(app.getHttpServer())
        .get('/products/scan/WHEY-1KG')
        .expect(401);
    });

    it('rejects a caller without inventory.read (e.g. a trainer)', async () => {
      // A user holding no inventory permissions at all.
      const trainerEmail = `scan-trainer-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 8)}@example.com`;
      const invited = await authed(org.accessToken)(
        request(app.getHttpServer()).post('/users').send({
          email: trainerEmail,
          firstName: 'Scan',
          lastName: 'Trainer',
          roleKey: 'TRAINER',
        }),
      ).expect(201);

      const prisma = app.get(PrismaService);
      const tokens = app.get(TokensService);
      await prisma.user.update({
        where: { id: invited.body.data.id },
        data: { status: 'ACTIVE' },
      });
      const trainerToken = tokens.signAccessToken(invited.body.data.id);

      await request(app.getHttpServer())
        .get('/products/scan/WHEY-1KG')
        .set('Authorization', `Bearer ${trainerToken}`)
        .expect(403);
    });
  });
});
