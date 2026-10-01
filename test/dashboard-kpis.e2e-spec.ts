import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, grantActiveMembership } from './utils/test-app';

/**
 * The owner dashboard's numbers, each pinned to what it claims to count.
 *
 * Every case here was wrong before it was written: a turned-away member
 * counted as a check-in and as a visit, "follow-ups due" was a total of
 * every follow-up on this month's leads, the member status chart never
 * noticed a membership expire, and Owner OS counted a same-day refund
 * twice and a renewed member twice.
 */
describe('Owner dashboard KPIs (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const DAY = 24 * 60 * 60 * 1000;

  interface Org {
    token: string;
    organizationId: string;
    userId: string;
    branchId: string;
  }

  async function registerOrg(name: string): Promise<Org> {
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email: `kpi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Kpi',
      })
      .expect(201);
    const token = res.body.data.accessToken as string;
    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return {
      token,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  const as = (org: Org) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${org.token}`);

  async function addMember(org: Org, firstName: string) {
    const res = await as(org)(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: org.branchId,
        firstName,
        lastName: 'Kpi',
      }),
    ).expect(201);
    return res.body.data.id as string;
  }

  async function briefing(org: Org) {
    const res = await as(org)(
      request(app.getHttpServer()).get('/briefing/daily'),
    ).expect(200);
    return res.body.data;
  }

  async function ownerOs(org: Org) {
    const res = await as(org)(
      request(app.getHttpServer()).get('/owner-os/briefing'),
    ).expect(200);
    return res.body.data;
  }

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (app) await app.close().catch(() => {});
  });

  describe("today's check-ins", () => {
    it('counts admitted members only: not denied attempts, not staff', async () => {
      const org = await registerOrg('KPI Checkins Gym');
      const paid = await addMember(org, 'Paid');
      await grantActiveMembership(app, org.token, paid);
      const unpaid = await addMember(org, 'Unpaid');

      const before = await briefing(org);
      expect(before.today).toEqual({ checkIns: 0, deniedCheckIns: 0 });

      await as(org)(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ memberId: paid, branchId: org.branchId }),
      ).expect(201);
      // Turned away twice: no membership. A denial answers 200.
      for (let i = 0; i < 2; i++) {
        const res = await as(org)(
          request(app.getHttpServer())
            .post('/attendance/check-in')
            .send({ memberId: unpaid, branchId: org.branchId }),
        ).expect(200);
        expect(res.body.data.allowed).toBe(false);
      }
      await as(org)(
        request(app.getHttpServer())
          .post('/attendance/check-in')
          .send({ staffUserId: org.userId, branchId: org.branchId }),
      ).expect(201);

      const after = await briefing(org);
      expect(after.today).toEqual({ checkIns: 1, deniedCheckIns: 2 });
      expect((await ownerOs(org)).metrics.todayAttendance).toBe(1);
    });
  });

  describe('members at risk', () => {
    it('is members with a running term and no admitted visit for 14 days', async () => {
      const org = await registerOrg('KPI Risk Gym');
      const old = new Date(Date.now() - 20 * DAY);

      // Paying, never came: at risk.
      const absent = await addMember(org, 'Absent');
      await grantActiveMembership(app, org.token, absent);
      await prisma.member.update({
        where: { id: absent },
        data: { joinedAt: old },
      });

      // Paying, last admitted 20 days ago, turned away yesterday: still
      // at risk -- the denial is not a visit.
      const turnedAway = await addMember(org, 'TurnedAway');
      await grantActiveMembership(app, org.token, turnedAway);
      await prisma.member.update({
        where: { id: turnedAway },
        data: { joinedAt: old },
      });
      await prisma.attendance.createMany({
        data: [
          {
            organizationId: org.organizationId,
            branchId: org.branchId,
            memberId: turnedAway,
            method: 'MANUAL',
            checkInAt: old,
          },
          {
            organizationId: org.organizationId,
            branchId: org.branchId,
            memberId: turnedAway,
            method: 'KIOSK',
            checkInAt: new Date(Date.now() - DAY),
            deniedReason: 'unpaid invoice INV-1',
          },
        ],
      });

      // Lapsed 20 days ago: churned, not at risk.
      const lapsed = await addMember(org, 'Lapsed');
      const { membershipId } = await grantActiveMembership(
        app,
        org.token,
        lapsed,
      );
      await prisma.member.update({
        where: { id: lapsed },
        data: { joinedAt: new Date(Date.now() - 60 * DAY) },
      });
      await prisma.membership.update({
        where: { id: membershipId },
        data: {
          startDate: new Date(Date.now() - 50 * DAY),
          endDate: old,
          status: 'EXPIRED',
        },
      });

      const res = await as(org)(
        request(app.getHttpServer()).get('/analytics/members/at-risk'),
      ).expect(200);
      const ids = (res.body.data as { id: string }[]).map((m) => m.id);
      expect(ids.sort()).toEqual([absent, turnedAway].sort());
      expect((await briefing(org)).atRiskMembers.count).toBe(2);
    });
  });

  describe('member status breakdown', () => {
    it('comes from membership terms, so an expired membership shows as expired', async () => {
      const org = await registerOrg('KPI Status Gym');

      const active = await addMember(org, 'Active');
      await grantActiveMembership(app, org.token, active);

      const expired = await addMember(org, 'Expired');
      const term = await grantActiveMembership(app, org.token, expired);
      // Still ACTIVE on the row, as it is until the hourly scan runs:
      // the date alone decides.
      await prisma.membership.update({
        where: { id: term.membershipId },
        data: {
          startDate: new Date(Date.now() - 40 * DAY),
          endDate: new Date(Date.now() - 2 * DAY),
        },
      });

      const upcoming = await addMember(org, 'Upcoming');
      const future = await grantActiveMembership(app, org.token, upcoming);
      await prisma.membership.update({
        where: { id: future.membershipId },
        data: {
          startDate: new Date(Date.now() + 5 * DAY),
          endDate: new Date(Date.now() + 35 * DAY),
        },
      });

      await addMember(org, 'Walkin');

      const res = await as(org)(
        request(app.getHttpServer()).get('/analytics/members/status-breakdown'),
      ).expect(200);
      expect(res.body.data).toEqual([
        { status: 'ACTIVE', count: 1 },
        { status: 'UPCOMING', count: 1 },
        { status: 'EXPIRED', count: 1 },
        { status: 'NO_MEMBERSHIP', count: 1 },
      ]);
    });
  });

  describe('follow-ups due', () => {
    it('counts open follow-ups due by the end of today, on any open lead', async () => {
      const org = await registerOrg('KPI Followups Gym');
      const lead = async (createdDaysAgo = 0, status?: 'WON' | 'LOST') => {
        const res = await as(org)(
          request(app.getHttpServer())
            .post('/leads')
            .send({ firstName: 'Lead', lastName: 'Kpi' }),
        ).expect(201);
        const id = res.body.data.id as string;
        if (createdDaysAgo || status) {
          await prisma.lead.update({
            where: { id },
            data: {
              ...(createdDaysAgo
                ? { createdAt: new Date(Date.now() - createdDaysAgo * DAY) }
                : {}),
              ...(status ? { status } : {}),
            },
          });
        }
        return id;
      };
      const followUp = async (leadId: string, dueInDays: number) => {
        const res = await as(org)(
          request(app.getHttpServer())
            .post(`/leads/${leadId}/follow-ups`)
            .send({
              dueAt: new Date(Date.now() + dueInDays * DAY).toISOString(),
              note: 'Call',
            }),
        ).expect(201);
        return res.body.data.id as string;
      };

      const fresh = await lead();
      await followUp(fresh, 0); // due now: counts
      await followUp(fresh, -2); // overdue: counts, and is overdue
      const done = await followUp(fresh, -1); // completed: does not count
      await as(org)(
        request(app.getHttpServer()).patch(
          `/leads/${fresh}/follow-ups/${done}/complete`,
        ),
      ).expect(200);
      await followUp(fresh, 3); // later: does not count

      // A lead from last month still owes today's call -- the old count
      // only looked at leads created this month.
      await followUp(await lead(40), -1);
      // A closed lead owes nothing.
      await followUp(await lead(0, 'LOST'), -1);

      expect((await briefing(org)).followUpsDue).toEqual({
        count: 3,
        overdue: 2,
      });
    });
  });

  describe('Owner OS', () => {
    it('nets a same-day refund once, so revenue never goes negative', async () => {
      const org = await registerOrg('KPI Refund Gym');
      const member = await addMember(org, 'Refunded');
      const before = (await ownerOs(org)).metrics.todayRevenue;

      const payment = await as(org)(
        request(app.getHttpServer())
          .post('/payments')
          .send({ memberId: member, amount: 1000 }),
      ).expect(201);
      await as(org)(
        request(app.getHttpServer())
          .post(`/payments/${payment.body.data.id}/refund`)
          .send({}),
      ).expect(201);

      expect((await ownerOs(org)).metrics.todayRevenue).toBe(before);
    });

    it('counts a renewed member once, and not as expiring', async () => {
      const org = await registerOrg('KPI Renewal Gym');
      const soon = new Date(Date.now() + 3 * DAY);

      const renewed = await addMember(org, 'Renewed');
      const first = await grantActiveMembership(app, org.token, renewed);
      await prisma.membership.update({
        where: { id: first.membershipId },
        data: { endDate: soon },
      });
      await as(org)(
        request(app.getHttpServer())
          .post(`/memberships/${first.membershipId}/renew`)
          .send({}),
      ).expect(201);

      const notRenewed = await addMember(org, 'NotRenewed');
      const other = await grantActiveMembership(app, org.token, notRenewed);
      await prisma.membership.update({
        where: { id: other.membershipId },
        data: { endDate: soon },
      });

      const { metrics } = await ownerOs(org);
      expect(metrics.activeMemberships).toBe(2);
      expect(metrics.expiringSoon).toBe(1);
    });
  });

  it("never shows one gym another gym's numbers", async () => {
    const a = await registerOrg('KPI Tenant A');
    const b = await registerOrg('KPI Tenant B');
    const member = await addMember(a, 'Visitor');
    await grantActiveMembership(app, a.token, member);
    await as(a)(
      request(app.getHttpServer())
        .post('/attendance/check-in')
        .send({ memberId: member, branchId: a.branchId }),
    ).expect(201);

    expect((await briefing(a)).today.checkIns).toBe(1);
    const other = await briefing(b);
    expect(other.today).toEqual({ checkIns: 0, deniedCheckIns: 0 });
    expect(other.followUpsDue).toEqual({ count: 0, overdue: 0 });
    expect((await ownerOs(b)).metrics.todayAttendance).toBe(0);
    const breakdown = await as(b)(
      request(app.getHttpServer()).get('/analytics/members/status-breakdown'),
    ).expect(200);
    expect(breakdown.body.data).toEqual([]);
  });
});
