import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

/**
 * D-DB02 (F-DB02): same-organization duplicate identities fail
 * deterministically with 409 CONFLICT at the service boundary.
 *
 * Mocked Prisma (no database). The race between two concurrent creates
 * and the database-level backstop are covered by
 * test/member-contact-conflict.e2e-spec.ts (requires .env.test DB).
 */
describe('MembersService contact uniqueness (D-DB02)', () => {
  let service: MembersService;
  let prisma: any;
  let tx: any;

  // Live members visible to the mocked tenant.
  const orgMembers = () => [
    { id: 'm1', email: 'rahul@gym.com', phone: '9876543210' },
    { id: 'm2', email: null, phone: '+91-98111 22222' },
  ];

  const findFirst = jest.fn();
  const findMany = jest.fn();

  beforeEach(async () => {
    findFirst.mockReset();
    findMany.mockReset();
    findFirst.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      // getOne by id (update path) and memberCode probe (create path).
      if (w.id && w.organizationId) {
        if (w.id === 'other-org-member') return null;
        return {
          id: w.id,
          organizationId: w.organizationId,
          primaryBranchId: 'b1',
          assignedTrainerId: null,
          status: 'ACTIVE',
          phone: '9876543210',
          alternatePhone: null,
        };
      }
      if (w.memberCode) return null;
      // Email clash probe from assertContactUnique (org-scoped: the
      // mocked members live in org-1; org-2 starts empty).
      if (w.email) {
        if (w.organizationId !== 'org-1') return null;
        const hit = orgMembers().find(
          (m) => m.email === w.email && m.id !== w.id?.not,
        );
        return hit ? { id: hit.id } : null;
      }
      return null;
    });
    findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      if (w.organizationId !== 'org-1') return [];
      const suffix = w.phone?.endsWith;
      if (!suffix) return [];
      return orgMembers()
        .filter((m) => (m.phone ?? '').replace(/\D/g, '').endsWith(suffix))
        .filter((m) => m.id !== w.id?.not)
        .map((m) => ({ id: m.id, phone: m.phone }));
    });
    tx = {
      member: {
        create: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'm-new',
          memberCode: 'M-000002',
          status: 'ACTIVE',
          ...data,
        })),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({
          id: 'm1',
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
        count: jest.fn().mockResolvedValue(2),
        findFirst,
        findMany,
        update: tx.member.update,
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

  const baseDto = () => ({
    primaryBranchId: 'b1',
    firstName: 'Asha',
    lastName: 'Verma',
  });

  it('create rejects a duplicate email regardless of case', async () => {
    await expect(
      service.create(
        'org-1',
        {
          ...baseDto(),
          email: 'RAHUL@Gym.COM',
          phone: '9000000001',
        } as any,
        null,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.member.create).not.toHaveBeenCalled();
  });

  it('create rejects a duplicate phone despite different formatting', async () => {
    await expect(
      service.create(
        'org-1',
        {
          ...baseDto(),
          email: 'new-person@gym.com',
          phone: '+91 98765 43210',
        } as any,
        null,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.member.create).not.toHaveBeenCalled();
  });

  it('create allows the same contact in another organization', async () => {
    const member = await service.create(
      'org-2',
      {
        ...baseDto(),
        email: 'rahul@gym.com',
        phone: '9876543210',
      } as any,
      null,
    );
    expect(member.id).toBe('m-new');
  });

  it('create allows blank contacts (nothing to collide on)', async () => {
    const member = await service.create(
      'org-1',
      {
        ...baseDto(),
        email: '',
        phone: '   ',
      } as any,
      null,
    );
    expect(member.id).toBe('m-new');
    expect(findMany).not.toHaveBeenCalled();
  });

  it('update rejects taking over a sibling member email', async () => {
    await expect(
      service.update('org-1', 'm2', { email: 'rahul@gym.com' } as any, null),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.member.update).not.toHaveBeenCalled();
  });

  it('update keeping its own values never self-conflicts', async () => {
    findFirst.mockImplementationOnce(async () => ({
      id: 'm1',
      organizationId: 'org-1',
      primaryBranchId: 'b1',
      assignedTrainerId: null,
      status: 'ACTIVE',
      phone: '9876543210',
      alternatePhone: null,
    }));
    const updated = await service.update(
      'org-1',
      'm1',
      { firstName: 'Rahul-Updated' } as any,
      null,
    );
    expect(updated.firstName).toBe('Rahul-Updated');
  });
});
