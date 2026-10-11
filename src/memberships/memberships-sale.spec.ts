import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../prisma/prisma.service';
import { MembershipsService } from './memberships.service';

/**
 * Plan v2 sale path: frozen snapshots, free trials, PT-credit grants.
 * Prisma + events are mocked; no database is touched.
 */
describe('MembershipsService plan v2 sale', () => {
  let service: MembershipsService;
  let prisma: any;
  let tx: any;

  const plan = {
    id: 'plan-1',
    branchId: null,
    name: 'Quarterly',
    durationDays: 90,
    price: { toFixed: () => '5000.00' },
    compareAtPrice: { toFixed: () => '6000.00' },
    joiningFee: { toFixed: () => '500.00' },
    currency: 'INR',
    taxMode: 'exclusive',
    taxRate: { toFixed: () => '18.00' },
    weeklyClassLimit: 3,
    ptSessionCredits: 2,
    trialDays: 7,
    termsAndConditions: 'No refunds.',
  };

  beforeEach(async () => {
    tx = {
      membership: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'ms-1',
          ...data,
        })),
      },
      payment: { create: jest.fn() },
      ptPackage: { create: jest.fn() },
    };
    prisma = {
      organization: {
        findUnique: jest.fn().mockResolvedValue({ timezone: null }),
      },
      member: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'm-1',
          primaryBranchId: 'b-1',
        }),
      },
      membershipPlan: {
        findFirst: jest.fn().mockResolvedValue(plan),
      },
      membership: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembershipsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(MembershipsService);
  });

  it('freezes the commercial terms into planSnapshot at sale', async () => {
    await service.create('org-1', {
      memberId: 'm-1',
      membershipPlanId: 'plan-1',
    } as never);
    expect(tx.membership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        isTrial: false,
        planSnapshot: expect.objectContaining({
          planId: 'plan-1',
          durationDays: 90,
          weeklyClassLimit: 3,
          ptSessionCredits: 2,
          taxMode: 'exclusive',
          termsAndConditions: 'No refunds.',
        }),
      }),
    });
  });

  it('grants included PT sessions as PtPackage rows', async () => {
    await service.create('org-1', {
      memberId: 'm-1',
      membershipPlanId: 'plan-1',
    } as never);
    expect(tx.ptPackage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        memberId: 'm-1',
        totalSessions: 2,
        status: 'ACTIVE',
      }),
    });
  });

  it('starts a free trial with a short term and no payment', async () => {
    const ms = await service.create('org-1', {
      memberId: 'm-1',
      membershipPlanId: 'plan-1',
      isTrial: true,
    } as never);
    expect(tx.membership.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isTrial: true, autoRenew: false }),
    });
    const termDays = Math.round(
      (new Date(ms.endDate).getTime() - new Date(ms.startDate).getTime()) /
        86_400_000,
    );
    expect(termDays).toBe(7);
    expect(tx.ptPackage.create).not.toHaveBeenCalled();
  });

  it('rejects a trial when the plan offers none', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      ...plan,
      trialDays: null,
    });
    await expect(
      service.create('org-1', {
        memberId: 'm-1',
        membershipPlanId: 'plan-1',
        isTrial: true,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a second trial for the same member', async () => {
    prisma.membership.findFirst.mockResolvedValue({ id: 'ms-old' });
    await expect(
      service.create('org-1', {
        memberId: 'm-1',
        membershipPlanId: 'plan-1',
        isTrial: true,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.membership.create).not.toHaveBeenCalled();
  });

  it('rejects payment on a free trial', async () => {
    await expect(
      service.create('org-1', {
        memberId: 'm-1',
        membershipPlanId: 'plan-1',
        isTrial: true,
        initialPayment: 100,
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
