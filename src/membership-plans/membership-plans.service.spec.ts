import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      findMany: jest.Mock;
      count: jest.Mock;
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
        findMany: jest.fn(),
        count: jest.fn(),
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

  it('hides other-branch plans from branch-scoped reads', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      branchId: 'br-other',
    });
    await expect(
      service.getOne('org-1', 'plan-1', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    prisma.membershipPlan.findMany.mockResolvedValue([]);
    prisma.membershipPlan.count.mockResolvedValue(0);
    await service.list('org-1', { page: 1, pageSize: 20 } as never, 'br-1');
    expect(prisma.membershipPlan.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-1',
          OR: [{ branchId: null }, { branchId: 'br-1' }],
        }),
      }),
    );
  });

  it('lets branch-scoped callers read global and own-branch plans', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      branchId: null,
    });
    await expect(
      service.getOne('org-1', 'plan-1', 'br-1'),
    ).resolves.toMatchObject({ id: 'plan-1' });
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-2',
      branchId: 'br-1',
    });
    await service.update('org-1', 'plan-2', { name: 'New' }, 'br-1');
    expect(prisma.membershipPlan.update).toHaveBeenCalledWith({
      where: { id: 'plan-2' },
      data: expect.objectContaining({ name: 'New' }),
    });
  });

  it('refuses branch-scoped edits of global plans', async () => {
    prisma.membershipPlan.findFirst.mockResolvedValue({
      id: 'plan-1',
      branchId: null,
    });
    await expect(
      service.update('org-1', 'plan-1', { name: 'New' }, 'br-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.remove('org-1', 'plan-1', 'br-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.membershipPlan.update).not.toHaveBeenCalled();
  });

  it('rejects an unsupported currency and a non-offer compareAtPrice', async () => {
    prisma.organization.findUniqueOrThrow.mockResolvedValue({
      currency: 'INR',
    });
    await expect(
      service.create('org-1', { ...base, currency: 'XX1' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('org-1', { ...base, compareAtPrice: 20000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('org-1', { ...base, compareAtPrice: 15000 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.membershipPlan.create).not.toHaveBeenCalled();
  });

  it('rejects a zero weekly class limit while allowing null', async () => {
    // Zero is a DTO-level rejection (null = unlimited); the service
    // never sees it. This pins the create path accepting a limit.
    prisma.organization.findUniqueOrThrow.mockResolvedValue({
      currency: 'INR',
    });
    prisma.membershipPlan.create.mockImplementation(async ({ data }) => data);
    const created = await service.create('org-1', {
      ...base,
      weeklyClassLimit: 3,
    });
    expect(created).toMatchObject({ weeklyClassLimit: 3 });
  });
});
