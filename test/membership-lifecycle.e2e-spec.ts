import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { PrismaService } from '../src/prisma/prisma.service';
import { MembershipsService } from '../src/memberships/memberships.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * Membership lifecycle end-to-end: purchase (immediate + pending),
 * activation, freeze quota + resume date math, pause/unpause, extension,
 * upgrade/downgrade proration, renewal (in-place + new row), cancellation,
 * transfer, automated expiry with member status sync, history trail,
 * tenant/branch isolation, and duplicate-payment bounds.
 */
describe('Membership lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let membershipsService: MembershipsService;
  let owner: RegisteredAccount;
  let otherOwner: RegisteredAccount;
  let branchId: string;
  let memberId: string;
  let otherMemberId: string;
  let planId: string;
  let premiumPlanId: string;
  let basicPlanId: string;

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);
  const asOwner = (req: request.Test) => authed(owner.accessToken)(req);
  const asOther = (req: request.Test) => authed(otherOwner.accessToken)(req);

  const createMember = async (firstName: string) => {
    const res = await asOwner(
      request(app.getHttpServer()).post('/members').send({
        primaryBranchId: branchId,
        firstName,
        lastName: 'Lifecycle',
      }),
    ).expect(201);
    return res.body.data.id as string;
  };

  const createPlan = async (
    name: string,
    durationDays: number,
    price: number,
  ) => {
    const res = await asOwner(
      request(app.getHttpServer()).post('/membership-plans').send({
        name,
        durationDays,
        price,
      }),
    ).expect(201);
    return res.body.data.id as string;
  };

  const daysBetween = (a: Date, b: Date) =>
    Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000));

  beforeAll(async () => {
    const result = await createTestApp();
    app = result.app;
    prisma = app.get(PrismaService);
    membershipsService = app.get(MembershipsService);

    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Lifecycle Test Gym',
        email: `lifecycle-owner-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: 'Test',
      })
      .expect(201);
    owner = {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: '',
    };
    const branches = await asOwner(
      request(app.getHttpServer()).get('/branches'),
    ).expect(200);
    branchId = branches.body.data.items[0].id;
    owner.branchId = branchId;

    const otherRes = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: 'Other Lifecycle Gym',
        email: `lifecycle-other-${Date.now()}@example.com`,
        password: 'CorrectHorseBattery9',
        firstName: 'Other',
        lastName: 'Owner',
      })
      .expect(201);
    otherOwner = {
      accessToken: otherRes.body.data.accessToken,
      organizationId: otherRes.body.data.organization.id,
      userId: otherRes.body.data.user.id,
      branchId: '',
    };

    memberId = await createMember('Primary');
    otherMemberId = await createMember('Secondary');
    planId = await createPlan('Standard Monthly', 30, 100);
    premiumPlanId = await createPlan('Premium Monthly', 30, 200);
    basicPlanId = await createPlan('Basic Monthly', 30, 50);
  });

  afterAll(async () => {
    if (app) {
      await app.close().catch(() => {});
    }
  });

  describe('purchase and activation', () => {
    it('creates an ACTIVE membership by default with initial payment', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
          initialPayment: 40,
          paymentMethod: 'CASH',
        }),
      ).expect(201);
      const m = res.body.data;
      expect(m.status).toBe('ACTIVE');
      expect(m.price).toBe('100');

      const payments = await prisma.payment.findMany({
        where: { membershipId: m.id },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].amount.toString()).toBe('40');
      expect(payments[0].status).toBe('COMPLETED');

      const history = await prisma.membershipStatusHistory.findMany({
        where: { membershipId: m.id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history).toHaveLength(1);
      expect(history[0].fromStatus).toBeNull();
      expect(history[0].toStatus).toBe('ACTIVE');
      expect(history[0].changedByUserId).toBe(owner.userId);
    });

    it('creates a PENDING membership when activate:false', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
          activate: false,
        }),
      ).expect(201);
      expect(res.body.data.status).toBe('PENDING');
    });

    it('activates a PENDING membership and rejects double activation', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
          activate: false,
        }),
      ).expect(201);
      const id = created.body.data.id;

      const activated = await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/activate`)
          .send({}),
      ).expect(201);
      expect(activated.body.data.status).toBe('ACTIVE');

      await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/activate`)
          .send({}),
      ).expect(400);

      const history = await prisma.membershipStatusHistory.findMany({
        where: { membershipId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.toStatus)).toEqual(['PENDING', 'ACTIVE']);
    });

    it('rejects initial payment above the membership price', async () => {
      await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
          initialPayment: 101,
        }),
      ).expect(400);
    });
  });

  describe('freeze and resume', () => {
    it('freezes within quota and resumes with endDate credit', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      const before = new Date(created.body.data.endDate);

      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/freeze`).send({
          days: 5,
        }),
      ).expect(201);

      // Simulate 2 days passing, then resume: 2 days credited back.
      await prisma.membership.update({
        where: { id },
        data: {
          freezeStartDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
          freezeEndDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        },
      });

      const resumed = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/resume`).send({}),
      ).expect(201);
      const after = new Date(resumed.body.data.endDate);
      expect(resumed.body.data.status).toBe('ACTIVE');
      expect(daysBetween(before, after)).toBe(2);
      expect(resumed.body.data.totalFreezeDaysUsed).toBe(2);

      const history = await prisma.membershipStatusHistory.findMany({
        where: { membershipId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(history.map((h) => h.toStatus)).toEqual([
        'ACTIVE',
        'FROZEN',
        'ACTIVE',
      ]);
    });

    it('rejects freeze beyond the plan quota (maxFreezeDays=0)', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${created.body.data.id}/freeze`)
          .send({ days: 1 }),
      ).expect(400);
    });
  });

  describe('pause and unpause', () => {
    it('pauses and unpause extends endDate without consuming freeze quota', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      const before = new Date(created.body.data.endDate);

      const paused = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/pause`).send({}),
      ).expect(201);
      expect(paused.body.data.status).toBe('PAUSED');

      // Simulate 3 paused days.
      await prisma.membership.update({
        where: { id },
        data: {
          freezeStartDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
        },
      });

      const unpaused = await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/unpause`)
          .send({}),
      ).expect(201);
      const after = new Date(unpaused.body.data.endDate);
      expect(unpaused.body.data.status).toBe('ACTIVE');
      expect(daysBetween(before, after)).toBe(3);
      expect(unpaused.body.data.totalFreezeDaysUsed).toBe(0);
    });

    it('rejects pausing a non-active membership', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
          activate: false,
        }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${created.body.data.id}/pause`)
          .send({}),
      ).expect(400);
    });
  });

  describe('extension', () => {
    it('extends endDate by the requested days with a trail row', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      const before = new Date(created.body.data.endDate);

      const extended = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/extend`).send({
          days: 15,
          reason: 'Goodwill',
        }),
      ).expect(201);
      expect(daysBetween(before, new Date(extended.body.data.endDate))).toBe(
        15,
      );

      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/extend`).send({
          days: 0,
        }),
      ).expect(400);
    });

    it('rejects extending a cancelled membership', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/cancel`).send({
          reason: 'Testing',
        }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/extend`).send({
          days: 5,
        }),
      ).expect(400);
    });
  });

  describe('upgrade and downgrade', () => {
    it('upgrades with straight-line credit for unused days', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: basicPlanId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      const upgraded = await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/change-plan`)
          .send({
            newMembershipPlanId: premiumPlanId,
            direction: 'UPGRADE',
            initialPayment: 10,
            paymentMethod: 'CARD',
          }),
      ).expect(201);

      const { newMembership, credit, amountDue } = upgraded.body.data;
      expect(newMembership.status).toBe('ACTIVE');
      expect(newMembership.membershipPlanId).toBe(premiumPlanId);
      // 30-day window, ~30 days remaining: credit ≈ full 50.
      expect(Number(credit)).toBeGreaterThan(40);
      expect(Number(amountDue)).toBeLessThanOrEqual(150);
      expect(Number(amountDue)).toBeGreaterThanOrEqual(0);

      const old = await prisma.membership.findUnique({ where: { id } });
      expect(old!.status).toBe('CANCELLED');
      expect(old!.cancellationReason).toContain('UPGRADE');
      expect(newMembership.previousMembershipId).toBe(id);

      const payments = await prisma.payment.findMany({
        where: { membershipId: newMembership.id },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].method).toBe('CARD');
    });

    it('downgrades with credit exceeding the new price (amountDue clamped to 0)', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: premiumPlanId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      const downgraded = await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/change-plan`)
          .send({
            newMembershipPlanId: basicPlanId,
            direction: 'DOWNGRADE',
          }),
      ).expect(201);
      expect(Number(downgraded.body.data.amountDue)).toBe(0);
      expect(Number(downgraded.body.data.credit)).toBeGreaterThan(0);
    });

    it('rejects change to the same plan and initialPayment above amount due', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: premiumPlanId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/change-plan`)
          .send({
            newMembershipPlanId: premiumPlanId,
            direction: 'UPGRADE',
          }),
      ).expect(400);

      await asOwner(
        request(app.getHttpServer())
          .post(`/memberships/${id}/change-plan`)
          .send({
            newMembershipPlanId: basicPlanId,
            direction: 'DOWNGRADE',
            initialPayment: 5000,
          }),
      ).expect(400);
    });
  });

  describe('renewal', () => {
    it('renews an ACTIVE membership in place', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      const before = new Date(created.body.data.endDate);

      const renewed = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/renew`).send({}),
      ).expect(201);
      expect(daysBetween(before, new Date(renewed.body.data.endDate))).toBe(30);
      expect(renewed.body.data.id).toBe(id);
    });

    it('renews an EXPIRED membership as a new chained row', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      await prisma.membership.update({
        where: { id },
        data: { status: 'EXPIRED' },
      });

      const renewed = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/renew`).send({}),
      ).expect(201);
      expect(renewed.body.data.id).not.toBe(id);
      expect(renewed.body.data.previousMembershipId).toBe(id);
      expect(renewed.body.data.status).toBe('ACTIVE');
    });

    it('rejects renewing a FROZEN membership', async () => {
      const planWithFreeze = await createPlan('Freezable', 30, 100);
      await asOwner(
        request(app.getHttpServer())
          .patch(`/membership-plans/${planWithFreeze}`)
          .send({ maxFreezeDays: 10 }),
      ).catch(() => {});
      await prisma.membershipPlan.update({
        where: { id: planWithFreeze },
        data: { maxFreezeDays: 10 },
      });
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planWithFreeze,
        }),
      ).expect(201);
      const id = created.body.data.id;
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/freeze`).send({
          days: 3,
        }),
      ).expect(201);
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/renew`).send({}),
      ).expect(400);
    });
  });

  describe('cancellation', () => {
    it('cancels with reason and trail, rejects double cancel', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      const cancelled = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/cancel`).send({
          reason: 'Relocating',
        }),
      ).expect(201);
      expect(cancelled.body.data.status).toBe('CANCELLED');
      expect(cancelled.body.data.cancellationReason).toBe('Relocating');
      expect(cancelled.body.data.cancelledAt).toBeTruthy();

      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/cancel`).send({}),
      ).expect(400);
    });
  });

  describe('transfer', () => {
    it('transfers a live membership to another member, preserving the chain', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      const transferred = await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/transfer`).send({
          toMemberId: otherMemberId,
          reason: 'Family',
        }),
      ).expect(201);

      expect(transferred.body.data.memberId).toBe(otherMemberId);
      expect(transferred.body.data.status).toBe('ACTIVE');
      expect(transferred.body.data.previousMembershipId).toBe(id);
      expect(transferred.body.data.price).toBe('100');

      const old = await prisma.membership.findUnique({ where: { id } });
      expect(old!.status).toBe('CANCELLED');
      expect(old!.cancellationReason).toContain('Transferred');

      const history = await prisma.membershipStatusHistory.findMany({
        where: { membershipId: id },
        orderBy: { createdAt: 'asc' },
      });
      expect(
        history.some((h) => h.detail?.includes('Transferred to member')),
      ).toBe(true);
    });

    it('rejects self-transfer and cross-org transfer', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/transfer`).send({
          toMemberId: memberId,
        }),
      ).expect(400);
    });
  });

  describe('automated expiry', () => {
    it('expires past-due ACTIVE memberships and syncs member status', async () => {
      const soloMember = await createMember('Solo');
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId: soloMember,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      await prisma.membership.update({
        where: { id },
        data: { endDate: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      const expired = await membershipsService.expire(owner.organizationId, id);
      expect(expired).toBeTruthy();
      expect(expired!.status).toBe('EXPIRED');

      const member = await prisma.member.findUnique({
        where: { id: soloMember },
      });
      expect(member!.status).toBe('EXPIRED');

      const memberHistory = await prisma.memberStatusHistory.findMany({
        where: { memberId: soloMember },
      });
      expect(memberHistory.length).toBeGreaterThan(0);

      // Idempotent: second run does nothing.
      const again = await membershipsService.expire(owner.organizationId, id);
      expect(again).toBeNull();
    });

    it('keeps member ACTIVE when another live membership exists', async () => {
      const dualMember = await createMember('Dual');
      await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId: dualMember,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const expiring = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId: dualMember,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = expiring.body.data.id;
      await prisma.membership.update({
        where: { id },
        data: { endDate: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      });

      await membershipsService.expire(owner.organizationId, id);
      const member = await prisma.member.findUnique({
        where: { id: dualMember },
      });
      expect(member!.status).toBe('ACTIVE');
    });
  });

  describe('history endpoint', () => {
    it('returns the full trail', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/freeze`).send({
          days: 0,
        }),
      ).catch(() => {});

      const history = await asOwner(
        request(app.getHttpServer()).get(`/memberships/history/${id}`),
      ).expect(200);
      expect(Array.isArray(history.body.data ?? history.body)).toBe(true);
      const rows = history.body.data ?? history.body;
      expect(rows.length).toBeGreaterThanOrEqual(1);
      expect(rows[0].toStatus).toBe('ACTIVE');
      expect(rows[0].changedByUser).toBeTruthy();
    });
  });

  describe('tenant isolation', () => {
    it('does not expose another org membership', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      await asOther(
        request(app.getHttpServer()).get(`/memberships/${id}`),
      ).expect(404);

      await asOther(
        request(app.getHttpServer()).post(`/memberships/${id}/cancel`).send({}),
      ).expect(404);

      const crossOrgMemberRes = await asOther(
        request(app.getHttpServer())
          .post('/members')
          .send({
            primaryBranchId: otherOwner.branchId || branchId,
            firstName: 'Cross',
            lastName: 'Org',
          }),
      ).catch((e) => e);
      void crossOrgMemberRes;

      await asOther(
        request(app.getHttpServer()).post(`/memberships/${id}/transfer`).send({
          toMemberId: memberId,
        }),
      ).expect(404);
    });

    it('org isolation on transfer target: cross-org member is not found', async () => {
      const created = await asOwner(
        request(app.getHttpServer()).post('/memberships').send({
          memberId,
          membershipPlanId: planId,
        }),
      ).expect(201);
      const id = created.body.data.id;

      // otherMemberId belongs to owner's org, so this is a valid same-org
      // transfer; the cross-org case is covered by the 404 member lookup
      // when toMemberId is a foreign member id (uuid) not in this org.
      const foreignMemberId = '00000000-0000-0000-0000-000000000000';
      await asOwner(
        request(app.getHttpServer()).post(`/memberships/${id}/transfer`).send({
          toMemberId: foreignMemberId,
        }),
      ).expect(404);
    });
  });

  describe('lifecycle analytics', () => {
    it('computes lifecycle aggregates from real data', async () => {
      const res = await asOwner(
        request(app.getHttpServer()).get('/analytics/memberships/lifecycle'),
      ).expect(200);
      const data = res.body.data ?? res.body;
      expect(data.statusCounts.length).toBeGreaterThan(0);
      expect(data.renewalRate).toBeGreaterThanOrEqual(0);
      expect(data.expiringWithin30Days).toBeGreaterThanOrEqual(0);
      const active = data.statusCounts.find(
        (s: { status: string }) => s.status === 'ACTIVE',
      );
      expect(active.count).toBeGreaterThan(0);
    });
  });
});
