import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/** Exercises the P2 Member/Sales/Trainer/Inventory intelligence
 * endpoints against real Postgres data -- see src/analytics/README.md
 * for the exact definitions being tested. */
describe('Analytics / intelligence (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
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
    app = await createTestApp();
    prisma = app.get(PrismaService);
    org = await registerOrg('Intelligence Test Gym');
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists an at-risk member, and excludes one who visited recently', async () => {
    const stale = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Stale',
        lastName: 'Member',
      }),
    ).expect(201);
    await prisma.member.update({
      where: { id: stale.body.data.id },
      data: { joinedAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000) },
    });

    const fresh = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Fresh',
        lastName: 'Member',
      }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/attendance/check-in').send({
        memberId: fresh.body.data.id,
        branchId: org.branchId,
      }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/members/at-risk'),
    ).expect(200);

    const ids = (res.body.data as { id: string }[]).map((m) => m.id);
    expect(ids).toContain(stale.body.data.id);
    expect(ids).not.toContain(fresh.body.data.id);

    const staleEntry = res.body.data.find(
      (m: { id: string }) => m.id === stale.body.data.id,
    );
    expect(staleEntry.neverCheckedIn).toBe(true);
    expect(staleEntry.daysSinceLastVisit).toBeGreaterThanOrEqual(20);
  });

  it('breaks down members by status', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/members/status-breakdown'),
    ).expect(200);
    const active = res.body.data.find(
      (r: { status: string }) => r.status === 'ACTIVE',
    );
    expect(active.count).toBeGreaterThanOrEqual(2); // stale + fresh from the previous test
  });

  it('computes a sales funnel: conversion rate, time-to-conversion, follow-up completion', async () => {
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/leads')
        .send({ firstName: 'Cold', lastName: 'Lead' }),
    ).expect(201);

    const willConvert = await authed(org.accessToken)(
      request(app.getHttpServer()).post('/leads').send({
        firstName: 'Converts',
        lastName: 'Lead',
        branchId: org.branchId,
      }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${willConvert.body.data.id}/convert`)
        .send({}),
    ).expect(201);

    const withFollowUp = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/leads')
        .send({ firstName: 'FollowedUp', lastName: 'Lead' }),
    ).expect(201);
    const followUp = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/leads/${withFollowUp.body.data.id}/follow-ups`)
        .send({
          dueAt: new Date().toISOString(),
          note: 'Call them',
        }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer()).patch(
        `/leads/${withFollowUp.body.data.id}/follow-ups/${followUp.body.data.id}/complete`,
      ),
    ).expect(200);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/sales/funnel'),
    ).expect(200);

    expect(res.body.data.totalLeads).toBeGreaterThanOrEqual(3);
    expect(res.body.data.wonLeads).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.data.conversionRatePct)).toBeGreaterThan(0);
    expect(res.body.data.averageDaysToConversion).not.toBeNull();
    expect(res.body.data.followUps.completed).toBeGreaterThanOrEqual(1);
    expect(Number(res.body.data.followUps.completionRatePct)).toBeGreaterThan(
      0,
    );
  });

  it('reports trainer workload for an assigned trainer', async () => {
    const trainer = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `trainer-${Date.now()}@example.com`,
          firstName: 'Coach',
          lastName: 'Trainer',
          primaryBranchId: org.branchId,
          roleKey: 'TRAINER',
          isTrainer: true,
        }),
    ).expect(201);

    await authed(org.accessToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName: 'Trained',
        lastName: 'Member',
        assignedTrainerId: trainer.body.data.id,
      }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/trainers/workload'),
    ).expect(200);

    const entry = res.body.data.trainers.find(
      (t: { userId: string }) => t.userId === trainer.body.data.id,
    );
    expect(entry).toBeDefined();
    expect(entry.assignedMemberCount).toBeGreaterThanOrEqual(1);
    expect(
      res.body.data.notComputable.map((n: { key: string }) => n.key),
    ).toEqual(
      expect.arrayContaining([
        'ptSessionUtilization',
        'ptRevenuePerTrainer',
        'commissionEarned',
      ]),
    );
  });

  it('forecasts stock-out for a product with recent sales, ranked soonest-first', async () => {
    const fastMover = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/products')
        .send({
          sku: `FAST-${Date.now()}`,
          name: 'Fast Mover',
          unitPrice: 5,
          quantityOnHand: 10,
          reorderLevel: 2,
        }),
    ).expect(201);
    await authed(org.accessToken)(
      request(app.getHttpServer())
        .post(`/products/${fastMover.body.data.id}/stock-movements`)
        .send({ type: 'SALE', quantity: 5 }),
    ).expect(201);

    const noMovement = await authed(org.accessToken)(
      request(app.getHttpServer())
        .post('/products')
        .send({
          sku: `IDLE-${Date.now()}`,
          name: 'Idle Product',
          unitPrice: 5,
          quantityOnHand: 10,
          reorderLevel: 2,
        }),
    ).expect(201);

    const res = await authed(org.accessToken)(
      request(app.getHttpServer()).get('/analytics/inventory/forecast'),
    ).expect(200);

    const fast = res.body.data.find(
      (p: { productId: string }) => p.productId === fastMover.body.data.id,
    );
    const idle = res.body.data.find(
      (p: { productId: string }) => p.productId === noMovement.body.data.id,
    );
    expect(fast.dailySalesRate).toBeGreaterThan(0);
    expect(fast.daysUntilStockout).not.toBeNull();
    expect(idle.dailySalesRate).toBe(0);
    expect(idle.daysUntilStockout).toBeNull();

    // Soonest-to-stock-out sorts before a product with no forecast.
    const fastIndex = res.body.data.findIndex(
      (p: { productId: string }) => p.productId === fastMover.body.data.id,
    );
    const idleIndex = res.body.data.findIndex(
      (p: { productId: string }) => p.productId === noMovement.body.data.id,
    );
    expect(fastIndex).toBeLessThan(idleIndex);
  });

  it('returns a revenue trend series covering the requested number of months', async () => {
    const res = await authed(org.accessToken)(
      request(app.getHttpServer())
        .get('/analytics/revenue/trend')
        .query({ months: 3 }),
    ).expect(200);

    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[2].month).toBe(new Date().toISOString().slice(0, 7));
  });
});
