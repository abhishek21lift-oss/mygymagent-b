import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma } from '@prisma/client';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

/**
 * `GET /members/:id/membership-billing` allows `members.read_assigned`
 * but never applied the assignment predicate: any trainer could read any
 * in-branch member's billing by substituting the member id. These tests
 * pin the intended scope at the service layer (no Redis/DB needed).
 */
describe('MembersService.getMembershipBilling assignment scope', () => {
  let service: MembersService;
  let prisma: {
    member: { findFirst: jest.Mock };
    membership: { findMany: jest.Mock };
    payment: { findMany: jest.Mock };
  };

  const memberRow = (assignedTrainerId: string | null) => ({
    id: 'mem-1',
    assignedTrainerId,
  });

  beforeEach(async () => {
    prisma = {
      member: { findFirst: jest.fn() },
      membership: { findMany: jest.fn().mockResolvedValue([]) },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PlatformBillingService, useValue: {} },
        { provide: TenantReferenceValidator, useValue: {} },
      ],
    }).compile();
    service = moduleRef.get(MembersService);
  });

  it('applies no trainer predicate for org-wide access', async () => {
    prisma.member.findFirst.mockResolvedValue(memberRow('other-trainer'));
    await service.getMembershipBilling('org-1', 'mem-1', null, null);
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: expect.not.objectContaining({
        assignedTrainerId: expect.anything(),
      }),
    });
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'mem-1', organizationId: 'org-1' }),
    });
  });

  it('lets a trainer read billing for their assigned member', async () => {
    prisma.member.findFirst.mockResolvedValue(memberRow('trainer-1'));
    const res = await service.getMembershipBilling(
      'org-1',
      'mem-1',
      null,
      'trainer-1',
    );
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({ assignedTrainerId: 'trainer-1' }),
    });
    expect(res).toHaveProperty('outstandingBalance');
  });

  it('denies a trainer billing for an unassigned member in the same branch', async () => {
    prisma.member.findFirst.mockResolvedValue(null);
    await expect(
      service.getMembershipBilling('org-1', 'mem-1', 'branch-1', 'trainer-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.member.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        organizationId: 'org-1',
        primaryBranchId: 'branch-1',
        assignedTrainerId: 'trainer-1',
      }),
    });
  });

  it('aggregates across the member’s own memberships only', async () => {
    prisma.member.findFirst.mockResolvedValue(memberRow('trainer-1'));
    prisma.membership.findMany.mockResolvedValue([
      {
        id: 'ms-1',
        price: new Prisma.Decimal(100),
        status: 'ACTIVE',
        membershipPlan: { name: 'Monthly' },
      },
    ]);
    prisma.payment.findMany.mockResolvedValue([
      {
        membershipId: 'ms-1',
        amount: new Prisma.Decimal(40),
        status: 'COMPLETED',
        refunds: [],
      },
    ]);
    const res = await service.getMembershipBilling(
      'org-1',
      'mem-1',
      null,
      'trainer-1',
    );
    expect(prisma.membership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          memberId: 'mem-1',
        }),
      }),
    );
    expect(Number(res.outstandingBalance)).toBe(60);
  });
});
