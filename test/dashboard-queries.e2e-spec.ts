import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { effectiveMemberStatus } from '../src/analytics/member-intelligence.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * The dashboard's heavier numbers, now counted in the database instead of
 * by loading rows. Each case pins the answer the in-memory version gave,
 * so the rewrite can't have changed what is counted -- only how.
 */
describe('Dashboard queries counted in the database (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let token: string;
  let organizationId: string;
  let userId: string;
  let branchId: string;

  const DAY = 24 * 60 * 60 * 1000;
  const as = (req: request.Test) => req.set('Authorization', `Bearer ${token}`);
  const get = async (path: string) =>
    (await as(request(app.getHttpServer()).get(path)).expect(200)).body.data;

  async function addMember(firstName: string, extra: object = {}) {
    const res = await as(
      request(app.getHttpServer())
        .post('/members')
        .send({
          primaryBranchId: branchId,
          firstName,
          lastName: 'Query',
          ...extra,
        }),
    ).expect(201);
    return res.body.data.id as string;
  }

  /** A paying member: a term running today. */
  async function payingMember(firstName: string) {
    const id = await addMember(firstName);
    const { membershipId } = await grantActiveMembership(app, token, id);
    return { id, membershipId };
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Query Count Gym',
        email: `queries-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Queries',
      })
      .expect(201);
    token = res.body.data.accessToken;
    organizationId = res.body.data.organization.id;
    userId = res.body.data.user.id;
    branchId = (await get('/branches')).items[0].id;
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  it('finds members at risk from their latest admitted visit', async () => {
    const visit = (memberId: string, daysAgo: number, denied = false) =>
      prisma.attendance.create({
        data: {
          organizationId,
          branchId,
          memberId,
          checkInAt: new Date(Date.now() - daysAgo * DAY),
          ...(denied ? { deniedReason: 'NO_ACTIVE_MEMBERSHIP' } : {}),
        },
      });
    const longAgo = new Date(Date.now() - 40 * DAY);

    // Last admitted 20 days ago; turned away yesterday. At risk, 20 days.
    const stale = await payingMember('Stale');
    await visit(stale.id, 30);
    await visit(stale.id, 20);
    await visit(stale.id, 1, true);
    // Never admitted, joined 40 days ago, though turned away once: at risk.
    const never = await payingMember('Never');
    await prisma.member.update({
      where: { id: never.id },
      data: { joinedAt: longAgo },
    });
    await visit(never.id, 2, true);
    // Came 3 days ago after a long gap: fine.
    const regular = await payingMember('Regular');
    await visit(regular.id, 25);
    await visit(regular.id, 3);
    // Joined this week and not in yet: fine.
    await payingMember('Newcomer');
    // Absent for weeks but nothing to pay for: churned, not at risk.
    const lapsed = await addMember('Lapsed');
    await prisma.member.update({
      where: { id: lapsed },
      data: { joinedAt: longAgo },
    });
    // Paying and absent, but marked inactive by staff: not on the list.
    const inactive = await payingMember('Inactive');
    await prisma.member.update({
      where: { id: inactive.id },
      data: { status: 'INACTIVE', joinedAt: longAgo },
    });

    const atRisk = await get('/analytics/members/at-risk');
    expect(
      atRisk.map((m: { firstName: string }) => ({
        firstName: m.firstName,
      })),
    ).toEqual([{ firstName: 'Never' }, { firstName: 'Stale' }]);
    expect(atRisk[0]).toMatchObject({
      daysSinceLastVisit: 40,
      neverCheckedIn: true,
    });
    expect(atRisk[1]).toMatchObject({
      daysSinceLastVisit: 20,
      neverCheckedIn: false,
    });

    const briefing = await get('/briefing/daily');
    expect(briefing.atRiskMembers.count).toBe(2);
  });

  it('breaks members down by status exactly as effectiveMemberStatus reads them', async () => {
    const now = Date.now();
    const shift = async (membershipId: string, data: object) =>
      prisma.membership.update({ where: { id: membershipId }, data });

    const frozen = await payingMember('Frozen');
    await shift(frozen.membershipId, { status: 'FROZEN' });
    const upcoming = await payingMember('Upcoming');
    await shift(upcoming.membershipId, {
      startDate: new Date(now + 5 * DAY),
      endDate: new Date(now + 35 * DAY),
    });
    const expired = await payingMember('Expired');
    await shift(expired.membershipId, {
      status: 'EXPIRED',
      startDate: new Date(now - 60 * DAY),
      endDate: new Date(now - 30 * DAY),
    });
    // Only a cancelled term: never really bought one.
    const cancelled = await payingMember('Cancelled');
    await shift(cancelled.membershipId, { status: 'CANCELLED' });
    // Frozen and running at once: running wins.
    const both = await payingMember('Both');
    const { membershipId: second } = await grantActiveMembership(
      app,
      token,
      both.id,
    );
    await shift(second, { status: 'FROZEN' });

    const members = await prisma.member.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        status: true,
        memberships: {
          where: { status: { not: 'CANCELLED' } },
          select: { status: true, startDate: true, endDate: true },
        },
      },
    });
    const expected = new Map<string, number>();
    for (const member of members) {
      const status = effectiveMemberStatus(member, new Date());
      expected.set(status, (expected.get(status) ?? 0) + 1);
    }

    const breakdown: { status: string; count: number }[] = await get(
      '/analytics/members/status-breakdown',
    );
    expect(new Map(breakdown.map((row) => [row.status, row.count]))).toEqual(
      expected,
    );
    // Every status is represented, so none of the six can hide a bug.
    expect(breakdown.map((row) => row.status)).toEqual([
      'ACTIVE',
      'FROZEN',
      'UPCOMING',
      'EXPIRED',
      'NO_MEMBERSHIP',
      'INACTIVE',
    ]);
  });

  it('sums outstanding dues net of refunds, ignoring failed payments, and Owner OS agrees', async () => {
    const before = (await get('/briefing/daily')).revenue.outstanding;
    const owed = (
      rows: { membershipsWithBalance: number; outstandingBalance: string }[],
    ) =>
      rows.reduce(
        (sum, row) => ({
          count: sum.count + row.membershipsWithBalance,
          total: sum.total + Number(row.outstandingBalance),
        }),
        { count: 0, total: 0 },
      );
    const start = owed(before);

    // Every membership granted above owes its full 50. Settle this one
    // in part: 30 paid, 10 of it refunded, and a 50 that failed.
    const member = await payingMember('Debtor');
    const membership = await prisma.membership.findUniqueOrThrow({
      where: { id: member.membershipId },
    });
    const pay = (amount: number, status: 'COMPLETED' | 'FAILED') =>
      prisma.payment.create({
        data: {
          organizationId,
          branchId,
          memberId: member.id,
          membershipId: member.membershipId,
          amount,
          currency: membership.currency,
          status,
        },
      });
    const paid = await pay(30, 'COMPLETED');
    await pay(50, 'FAILED');
    await prisma.refund.create({
      data: { organizationId, paymentId: paid.id, amount: 10 },
    });
    // Fully paid: owes nothing, so not counted.
    const settled = await payingMember('Settled');
    await prisma.payment.create({
      data: {
        organizationId,
        branchId,
        memberId: settled.id,
        membershipId: settled.membershipId,
        amount: 50,
        currency: membership.currency,
        status: 'COMPLETED',
      },
    });

    const after = owed((await get('/briefing/daily')).revenue.outstanding);
    expect(after.count).toBe(start.count + 1);
    expect(after.total).toBeCloseTo(start.total + 30, 2);

    const ownerOs = await get('/owner-os/briefing');
    expect(ownerOs.currency).toBe(membership.currency);
    expect(ownerOs.metrics.outstandingPayments).toBeCloseTo(after.total, 2);
  });

  it("counts each trainer's members and plans", async () => {
    const invite = async (email: string) => {
      const res = await as(
        request(app.getHttpServer())
          .post('/users')
          .send({
            email,
            firstName: 'Coach',
            lastName: email.slice(0, 4),
            primaryBranchId: branchId,
            roleKey: 'TRAINER',
            isTrainer: true,
          }),
      ).expect(201);
      await prisma.user.update({
        where: { id: res.body.data.id },
        data: { status: 'ACTIVE' },
      });
      return res.body.data.id as string;
    };
    const busy = await invite(`busy-${Date.now()}@example.com`);
    const idle = await invite(`idle-${Date.now()}@example.com`);

    const trained = [];
    for (const name of ['One', 'Two']) {
      trained.push(await addMember(name, { assignedTrainerId: busy }));
    }
    const plan = await prisma.workoutPlan.create({
      data: { organizationId, name: 'Strength block', createdByUserId: userId },
    });
    await prisma.workoutAssignment.create({
      data: {
        organizationId,
        workoutPlanId: plan.id,
        memberId: trained[0],
        assignedByUserId: busy,
      },
    });
    // Outside the 30-day window: not counted.
    await prisma.workoutAssignment.create({
      data: {
        organizationId,
        workoutPlanId: plan.id,
        memberId: trained[1],
        assignedByUserId: busy,
        createdAt: new Date(Date.now() - 45 * DAY),
      },
    });

    const { trainers } = await get('/analytics/trainers/workload');
    const of = (id: string) =>
      trainers.find((t: { userId: string }) => t.userId === id);
    expect(of(busy)).toMatchObject({
      assignedMemberCount: 2,
      workoutPlansAssignedLast30Days: 1,
      dietPlansAssignedLast30Days: 0,
    });
    expect(of(idle)).toMatchObject({
      assignedMemberCount: 0,
      workoutPlansAssignedLast30Days: 0,
      dietPlansAssignedLast30Days: 0,
    });
    // Busiest first.
    expect(trainers[0].userId).toBe(busy);
  });

  it("counts the funnel's follow-ups, done and not", async () => {
    const lead = await prisma.lead.create({
      data: { organizationId, branchId, firstName: 'Lead', lastName: 'One' },
    });
    await prisma.leadFollowUp.createMany({
      data: [
        { organizationId, leadId: lead.id, dueAt: new Date(), note: 'a' },
        { organizationId, leadId: lead.id, dueAt: new Date(), note: 'b' },
        {
          organizationId,
          leadId: lead.id,
          dueAt: new Date(),
          note: 'c',
          completedAt: new Date(),
        },
      ],
    });
    const funnel = await get('/analytics/sales/funnel');
    expect(funnel.followUps).toEqual({
      total: 3,
      completed: 1,
      completionRatePct: '33.33',
    });
  });
});
