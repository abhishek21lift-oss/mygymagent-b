import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

/**
 * Add Member enhancement: alternate mobile, emergency email, full address,
 * referral attribution. Pins persistence + validation + tenant isolation at
 * the service layer (no Redis/DB needed).
 */
describe('MembersService contact enhancement', () => {
  let service: MembersService;
  let prisma: any;
  let tx: any;
  // The stored row returned for member m1; tests mutate its contact
  // fields to cover effective-pair PATCH validation.
  let beforeRow: any;

  const baseDto = () => ({
    primaryBranchId: 'b1',
    firstName: 'Rahul',
    lastName: 'Sharma',
    phone: '9876543210',
  });

  // Referrers known to the mocked tenant, keyed by home branch.
  const tenantMembers: Record<string, any> = {
    'ref-1': { id: 'ref-1', primaryBranchId: 'b1' },
    'ref-b2': { id: 'ref-b2', primaryBranchId: 'b2' },
  };

  beforeEach(async () => {
    beforeRow = {
      id: 'm1',
      organizationId: 'org-1',
      primaryBranchId: 'b1',
      assignedTrainerId: null,
      status: 'ACTIVE',
      phone: '9876543210',
      alternatePhone: '9811111111',
    };
    tx = {
      member: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'm1',
          memberCode: 'M-000001',
          primaryBranchId: data.primaryBranchId,
          status: 'ACTIVE',
          ...data,
        })),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'm1',
          memberCode: 'M-000001',
          ...data,
        })),
      },
      memberStatusHistory: { create: jest.fn() },
      memberBranchHistory: { create: jest.fn() },
      memberTrainerHistory: { create: jest.fn() },
      memberEmergencyContact: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
      memberConsent: { create: jest.fn() },
      memberGoal: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      referral: {
        create: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      lead: { updateMany: jest.fn() },
    };
    prisma = {
      member: {
        count: jest.fn().mockResolvedValue(0),
        // D-DB02: the service now probes findFirst (email) + findMany
        // (phone suffix) for per-organization conflicts before writing.
        // This fixture tenant holds no conflicting contacts.
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          // Referrer lookup: tenant members are visible only when the
          // caller's branch scope (if any) matches their home branch.
          const id = args?.where?.id;
          if (id === 'other-org-member') return null;
          if (id && tenantMembers[id]) {
            const known = tenantMembers[id];
            if (
              args?.where?.primaryBranchId &&
              known.primaryBranchId !== args.where.primaryBranchId
            )
              return null;
            return known;
          }
          // Member-code collision probe during creation.
          if (args?.where?.memberCode) return null;
          // Stored row for updates (getOne).
          if (id === 'm1') return beforeRow;
          return null;
        }),
      },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MembersService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        {
          provide: PlatformBillingService,
          useValue: { assertUnder: jest.fn() },
        },
        {
          provide: TenantReferenceValidator,
          useValue: { checkMemberReferences: jest.fn().mockResolvedValue([]) },
        },
      ],
    }).compile();
    service = moduleRef.get(MembersService);
  });

  it('persists alternate mobile, full address, emergency email and referral', async () => {
    const member = await service.create('org-1', {
      ...baseDto(),
      alternatePhone: '9811111111',
      addressLine1: '12 Main St',
      addressLine2: 'Indiranagar',
      city: 'Bengaluru',
      state: 'Karnataka',
      postalCode: '560038',
      country: 'India',
      emergencyContactName: 'Sita',
      emergencyContactPhone: '9822222222',
      emergencyContactRelationship: 'Spouse',
      emergencyContactEmail: 'sita@example.com',
      referrerMemberId: 'ref-1',
    } as any);
    expect(member.alternatePhone).toBe('9811111111');
    expect(tx.memberEmergencyContact.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        email: 'sita@example.com',
        relationship: 'Spouse',
      }),
    });
    expect(tx.referral.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        organizationId: 'org-1',
        referrerMemberId: 'ref-1',
        referredMemberId: 'm1',
        status: 'CONVERTED',
      }),
    });
  });

  it('creates a member without optional fields', async () => {
    const member = await service.create('org-1', baseDto() as any);
    expect(member.id).toBe('m1');
    expect(tx.memberEmergencyContact.create).not.toHaveBeenCalled();
    expect(tx.referral.create).not.toHaveBeenCalled();
  });

  it('rejects an alternate number identical to the primary', async () => {
    await expect(
      service.create('org-1', {
        ...baseDto(),
        alternatePhone: '98765 43210',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a short alternate number and a bad PIN', async () => {
    await expect(
      service.create('org-1', { ...baseDto(), alternatePhone: '123' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create('org-1', { ...baseDto(), postalCode: '12' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a cross-tenant referrer', async () => {
    await expect(
      service.create('org-1', {
        ...baseDto(),
        referrerMemberId: 'other-org-member',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects self-referral on update', async () => {
    await expect(
      service.update('org-1', 'm1', { referrerMemberId: 'm1' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('updates one field without erasing emergency contact details', async () => {
    tx.memberEmergencyContact.findFirst.mockResolvedValue({
      id: 'ec-1',
      name: 'Sita',
      phone: '9822222222',
      relationship: 'Spouse',
      email: 'sita@example.com',
    });
    await service.update('org-1', 'm1', { city: 'Pune' } as any);
    // No emergency field sent: the emergency row is left alone.
    expect(tx.memberEmergencyContact.update).not.toHaveBeenCalled();
    expect(tx.member.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ city: 'Pune' }),
    });
  });

  it('merges a single emergency email edit onto the existing contact', async () => {
    tx.memberEmergencyContact.findFirst.mockResolvedValue({
      id: 'ec-1',
      name: 'Sita',
      phone: '9822222222',
      relationship: 'Spouse',
      email: null,
    });
    await service.update('org-1', 'm1', {
      emergencyContactEmail: 'new@example.com',
    } as any);
    expect(tx.memberEmergencyContact.update).toHaveBeenCalledWith({
      where: { id: 'ec-1' },
      data: expect.objectContaining({
        name: 'Sita',
        phone: '9822222222',
        email: 'new@example.com',
      }),
    });
  });

  it('allows a same-branch referrer for a branch-scoped caller', async () => {
    await service.create(
      'org-1',
      { ...baseDto(), referrerMemberId: 'ref-1' } as any,
      'b1',
    );
    expect(tx.referral.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a cross-branch referrer for a branch-scoped caller', async () => {
    await expect(
      service.create(
        'org-1',
        { ...baseDto(), referrerMemberId: 'ref-b2' } as any,
        'b1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update(
        'org-1',
        'm1',
        { referrerMemberId: 'ref-b2' } as any,
        'b1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.referral.create).not.toHaveBeenCalled();
  });

  it('allows cross-branch referral for organization-wide callers', async () => {
    await service.create(
      'org-1',
      { ...baseDto(), referrerMemberId: 'ref-b2' } as any,
      null,
    );
    expect(tx.referral.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a PATCHed alternate matching the stored primary', async () => {
    await expect(
      service.update('org-1', 'm1', {
        alternatePhone: '98765 43210',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('rejects a PATCHed primary matching the stored alternate', async () => {
    await expect(
      service.update('org-1', 'm1', { phone: '98111 11111' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('leaves legacy matching stored pairs alone on unrelated PATCHes', async () => {
    beforeRow.phone = '9999999999';
    beforeRow.alternatePhone = '9999999999';
    await service.update('org-1', 'm1', { city: 'Pune' } as any);
    expect(tx.member.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ city: 'Pune' }),
    });
  });

  it('allows clearing a duplicated legacy alternate', async () => {
    beforeRow.phone = '9999999999';
    beforeRow.alternatePhone = '9999999999';
    await service.update('org-1', 'm1', { alternatePhone: null } as any);
    expect(tx.member.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: expect.objectContaining({ alternatePhone: null }),
    });
  });

  it('does not attribute twice when a referral already exists', async () => {
    tx.referral.findFirst.mockResolvedValue({ id: 'r1' });
    await service.update('org-1', 'm1', {
      referrerMemberId: 'ref-1',
    } as any);
    expect(tx.referral.create).not.toHaveBeenCalled();
  });
});
