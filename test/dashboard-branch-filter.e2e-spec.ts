import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TokensService } from '../src/auth/tokens.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * Reports by branch.
 *
 * An owner could not see one branch: report routes honoured only the
 * enforced branch scope, which is null for anyone holding the permission
 * org-wide, and the Intelligence page's `?branchId=` was rejected outright
 * by the whitelist (400) on the revenue routes. Low stock and the stock
 * forecast ignored branches entirely, so a branch manager saw the whole
 * organization's stock, and a branch could run out unflagged while the
 * total cleared the reorder level.
 */
describe('Dashboard and reports by branch (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let ownerToken: string;
  let organizationId: string;
  let branchA: string;
  let branchB: string;
  let managerToken: string;
  // A branch-restricted grant is only honoured with the branch named in
  // x-branch-id, which the web app always sends: the manager's own.
  let managerBranch: string;

  const DAY = 24 * 60 * 60 * 1000;
  const as = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const get = (
    token: string,
    path: string,
    query: Record<string, string> = {},
  ) => {
    const req = as(token)(request(app.getHttpServer()).get(path).query(query));
    return token === managerToken ? req.set('x-branch-id', managerBranch) : req;
  };

  async function memberAt(branchId: string, name: string, visit: boolean) {
    const res = await as(ownerToken)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName: name,
        lastName: 'Branch',
      }),
    ).expect(201);
    const id = res.body.data.id as string;
    await grantActiveMembership(app, ownerToken, id);
    if (visit) {
      await as(ownerToken)(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ memberId: id, branchId }),
      ).expect(201);
    }
    return id;
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);

    const registered = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Branch Filter Gym',
        email: `branch-filter-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Branches',
      })
      .expect(201);
    ownerToken = registered.body.data.accessToken;
    organizationId = registered.body.data.organization.id;
    const branches = await get(ownerToken, '/branches').expect(200);
    branchA = branches.body.data.items[0].id;
    const b = await as(ownerToken)(
      request(app.getHttpServer())
        .post('/branches')
        .send({ name: 'Branch B', slug: `branch-b-${Date.now()}` }),
    ).expect(201);
    branchB = b.body.data.id;

    const invited = await as(ownerToken)(
      request(app.getHttpServer())
        .post('/users')
        .send({
          email: `branch-filter-manager-${Date.now()}@example.com`,
          firstName: 'Branch',
          lastName: 'Manager',
          primaryBranchId: branchA,
          roleKey: 'BRANCH_MANAGER',
          roleBranchId: branchA,
        }),
    ).expect(201);
    await prisma.user.update({
      where: { id: invited.body.data.id },
      data: { status: 'ACTIVE' },
    });
    managerToken = app.get(TokensService).signAccessToken(invited.body.data.id);
    managerBranch = branchA;

    // Branch A: one visit and one member who never comes. Branch B: two
    // visits.
    await memberAt(branchA, 'Avisit', true);
    const absent = await memberAt(branchA, 'Aabsent', false);
    await prisma.member.update({
      where: { id: absent },
      data: { joinedAt: new Date(Date.now() - 20 * DAY) },
    });
    await memberAt(branchB, 'Bone', true);
    await memberAt(branchB, 'Btwo', true);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('lets an owner narrow the daily briefing to one branch', async () => {
    const all = await get(ownerToken, '/briefing/daily').expect(200);
    expect(all.body.data.today.checkIns).toBe(3);
    expect(all.body.data.branchId).toBeNull();

    const a = await get(ownerToken, '/briefing/daily', {
      branchId: branchA,
    }).expect(200);
    expect(a.body.data.branchId).toBe(branchA);
    expect(a.body.data.today.checkIns).toBe(1);
    expect(a.body.data.atRiskMembers.count).toBe(1);

    const b = await get(ownerToken, '/briefing/daily', {
      branchId: branchB,
    }).expect(200);
    expect(b.body.data.today.checkIns).toBe(2);
    expect(b.body.data.atRiskMembers.count).toBe(0);
  });

  it('accepts ?branchId= on every report the Intelligence page filters', async () => {
    // These returned 400 ("property branchId should not exist") before.
    for (const path of [
      '/analytics/revenue',
      '/analytics/revenue/trend',
      '/analytics/members/at-risk',
      '/analytics/members/status-breakdown',
      '/analytics/sales/funnel',
      '/analytics/sales/sources',
      '/analytics/memberships/lifecycle',
      '/analytics/trainers/workload',
      '/analytics/inventory/forecast',
    ]) {
      await get(ownerToken, path, { branchId: branchA }).expect(200);
    }

    const breakdownB = await get(
      ownerToken,
      '/analytics/members/status-breakdown',
      { branchId: branchB },
    ).expect(200);
    expect(breakdownB.body.data).toEqual([{ status: 'ACTIVE', count: 2 }]);
  });

  it('refuses a branchId that is not an id', async () => {
    await get(ownerToken, '/briefing/daily', { branchId: 'main' }).expect(400);
  });

  it("never lets a branch manager widen to another branch's numbers", async () => {
    const own = await get(managerToken, '/briefing/daily').expect(200);
    const asked = await get(managerToken, '/briefing/daily', {
      branchId: branchB,
    }).expect(200);
    // The enforced scope wins over the filter: still Branch A.
    expect(asked.body.data.branchId).toBe(branchA);
    expect(asked.body.data.today.checkIns).toBe(own.body.data.today.checkIns);
    expect(asked.body.data.today.checkIns).toBe(1);

    const breakdown = await get(
      managerToken,
      '/analytics/members/status-breakdown',
      { branchId: branchB },
    ).expect(200);
    expect(breakdown.body.data).toEqual([{ status: 'ACTIVE', count: 2 }]);
  });

  describe('stock by branch', () => {
    let productId: string;

    beforeAll(async () => {
      // 20 on hand in total, but Branch A holds only 1.
      const product = await prisma.product.create({
        data: {
          organizationId,
          sku: `WHEY-${Date.now()}`,
          name: 'Whey 1kg',
          unitPrice: 2500,
          quantityOnHand: 20,
          reorderLevel: 5,
        },
      });
      productId = product.id;
      await prisma.productStock.createMany({
        data: [
          { organizationId, branchId: branchA, productId, quantityOnHand: 1 },
          { organizationId, branchId: branchB, productId, quantityOnHand: 19 },
        ],
      });
    });

    const whey = (rows: { productId: string }[]) =>
      rows.find((row) => row.productId === productId) as
        { quantityOnHand: number; atOrBelowReorderLevel: boolean } | undefined;

    it('flags a branch that is running out though the total is fine', async () => {
      const all = await get(ownerToken, '/analytics/inventory/forecast').expect(
        200,
      );
      expect(whey(all.body.data)).toMatchObject({
        quantityOnHand: 20,
        atOrBelowReorderLevel: false,
      });

      const a = await get(ownerToken, '/analytics/inventory/forecast', {
        branchId: branchA,
      }).expect(200);
      expect(whey(a.body.data)).toMatchObject({
        quantityOnHand: 1,
        atOrBelowReorderLevel: true,
      });

      const briefingA = await get(ownerToken, '/briefing/daily', {
        branchId: branchA,
      }).expect(200);
      expect(briefingA.body.data.lowStock.count).toBe(1);
      const briefingAll = await get(ownerToken, '/briefing/daily').expect(200);
      expect(briefingAll.body.data.lowStock.count).toBe(0);
    });

    it("shows a branch manager their branch's stock, not the organization's", async () => {
      const res = await get(
        managerToken,
        '/analytics/inventory/forecast',
      ).expect(200);
      expect(whey(res.body.data)?.quantityOnHand).toBe(1);
    });
  });

  it('lists memberships expiring this week that have not been renewed', async () => {
    const before = (await get(ownerToken, '/briefing/daily').expect(200)).body
      .data.expiringSoon;
    expect(before).toEqual({ count: 0, withinDays: 7 });

    const memberships = await prisma.membership.findMany({
      where: { organizationId, status: 'ACTIVE' },
      select: { id: true },
      take: 2,
    });
    for (const m of memberships) {
      await prisma.membership.update({
        where: { id: m.id },
        data: { endDate: new Date(Date.now() + 3 * DAY) },
      });
    }
    await as(ownerToken)(
      request(app.getHttpServer())
        .post(`/memberships/${memberships[0].id}/renew`)
        .send({}),
    ).expect(201);

    const after = (await get(ownerToken, '/briefing/daily').expect(200)).body
      .data.expiringSoon;
    expect(after).toEqual({ count: 1, withinDays: 7 });
  });
});
