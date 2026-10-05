import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MembershipPlansService } from './membership-plans.service';
import { PrismaService } from '../prisma/prisma.service';

describe('MembershipPlansService', () => {
  let service: MembershipPlansService;
  let prisma: {
    organization: { findUniqueOrThrow: jest.Mock };
    branch: { findFirst: jest.Mock };
    membershipPlan: {
      findFirst: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prisma = {
      organization: { findUniqueOrThrow: jest.fn() },
      branch: { findFirst: jest.fn() },
      membershipPlan: {
        findFirst: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembershipPlansService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(MembershipPlansService);
  });

  const base = {
    name: '12-Month Unlimited',
    durationDays: 365,
    price: 20000,
  };

  it('falls back to the organization currency when none is sent', async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({
      currency: 'INR',
    });
    prisma.membershipPlan.create.mockImplementation(async ({ data }) => data);
    const created = await service.create('org-1', { ...base });
    expect(created.currency).toBe('INR');
    expect(prisma.branch.findFirst).not.toHaveBeenCalled();
  });

  it('passes display fields through untouched', async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({
      currency: 'INR',
    });
    prisma.branch.findFirst.mockResolvedValue({ id: 'br-1' });
    prisma.membershipPlan.create.mockImplementation(async ({ data }) => data);
    const created = await service.create('org-1', {
      ...base,
      branchId: 'br-1',
      code: 'YR-UNLTD',
      category: 'Premium',
      isFeatured: true,
      isPublic: false,
    });
    expect(created).toMatchObject({
      code: 'YR-UNLTD',
      category: 'Premium',
      isFeatured: true,
      isPublic: false,
    });
    expect(prisma.branch.findFirst).toHaveBeenCalledWith({
      where: { id: 'br-1', organizationId: 'org-1' },
      select: { id: true },
    });
  });

  it('rejects a branch from another tenant', async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({
      currency: 'INR',
    });
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(
      service.create('org-1', { ...base, branchId: 'foreign' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.membershipPlan.create).not.toHaveBeenCalled();
  });

  it('checks the branch on update too', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({ id: 'plan-1' });
    prisma.branch.findFirst.mockResolvedValue(null);
    await expect(
      service.update('org-1', 'plan-1', { branchId: 'foreign' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
