import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PlatformBillingService } from '../platform-billing/platform-billing.service';
import { TenantReferenceValidator } from '../common/validators/tenant-reference.validator';
import { PrismaService } from '../prisma/prisma.service';
import { MembersService } from './members.service';

/**
 * D-DB01 (F-DB01): member removal must never destroy history.
 *
 * The API exposes soft-delete only (deletedAt + INACTIVE); the schema backs
 * it with ON DELETE RESTRICT on every member-child FK (migration
 * 20261014184923_member_history_restrict). These service-layer tests pin the
 * soft-delete behavior without needing a database (mocked Prisma, same
 * pattern as members-contact-fields.spec.ts). The DB-level RESTRICT half is
 * covered by test/member-delete-history.e2e-spec.ts (requires .env.test DB).
 */
describe('MembersService remove (history preservation)', () => {
  let service: MembersService;
  let prisma: any;

  const stored = {
    id: 'm1',
    organizationId: 'org-1',
    primaryBranchId: 'b1',
    status: 'ACTIVE',
    deletedAt: null,
  };

  beforeEach(async () => {
    prisma = {
      member: {
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          if (
            args?.where?.id === 'm1' &&
            args?.where?.organizationId === 'org-1'
          )
            return { ...stored };
          return null;
        }),
        update: jest.fn().mockImplementation(async (args: any) => ({
          ...stored,
          ...args.data,
        })),
        // Deliberately absent: the service must never hard-delete members.
      },
      $transaction: jest.fn(),
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

  it('soft-deletes via deletedAt + INACTIVE instead of destroying the row', async () => {
    await service.remove('org-1', 'm1', null);
    expect(prisma.member.update).toHaveBeenCalledTimes(1);
    expect(prisma.member.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: {
        deletedAt: expect.any(Date),
        status: 'INACTIVE',
        // D-DB02: soft-delete releases the identity keys (the raw
        // contact stays for history).
        emailKey: null,
        phoneKey: null,
      },
    });
  });

  it('exposes no hard-delete path on the service Prisma delegate', () => {
    expect((prisma.member as any).delete).toBeUndefined();
  });

  it('still 404s for another organization member (tenant guard intact)', async () => {
    await expect(service.remove('org-2', 'm1', null)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.member.update).not.toHaveBeenCalled();
  });
});
