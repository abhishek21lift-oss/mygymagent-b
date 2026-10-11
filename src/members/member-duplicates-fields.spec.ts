import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { MemberDuplicatesService } from './member-duplicates.service';

/**
 * Merge whitelist for the Add Member contact fields: the preview must
 * offer the source alternate number and emergency-email snapshot, and
 * execution must copy them only on an explicit source win -- a missing
 * resolution keeps the target (no unexpected overwrites).
 */
describe('MemberDuplicatesService new contact fields', () => {
  let service: MemberDuplicatesService;
  let prisma: any;
  let tx: any;

  const source = {
    id: 's1',
    memberCode: 'M-000001',
    userId: null,
    primaryBranchId: 'b1',
    alternatePhone: '9811111111',
    emergencyContactEmail: 'sita@example.com',
  };
  const target = {
    id: 't1',
    memberCode: 'M-000002',
    userId: null,
    primaryBranchId: 'b1',
    alternatePhone: null,
    emergencyContactEmail: null,
  };

  beforeEach(async () => {
    const updateMany = jest.fn();
    const base: any = {
      member: { update: jest.fn() },
      memberStatusHistory: { create: jest.fn() },
      lead: {
        findUnique: jest.fn().mockResolvedValue(null),
        update: jest.fn(),
      },
    };
    // executeMerge moves every child collection generically; models
    // present for other calls keep their fns and gain updateMany.
    tx = new Proxy(base, {
      get: (t, p) => {
        const v = (t as any)[p];
        if (v && typeof v.updateMany === 'function') return v;
        if (typeof p === 'symbol') return v;
        return {
          ...(typeof v === 'object' && v !== null ? v : {}),
          updateMany,
        };
      },
    });
    prisma = {
      member: {
        findFirst: jest.fn().mockImplementation(async (args: any) => {
          if (args?.where?.id === 's1') return source;
          if (args?.where?.id === 't1') return target;
          return null;
        }),
      },
      membership: { count: jest.fn().mockResolvedValue(0) },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      $transaction: jest.fn().mockImplementation(async (cb: any) => cb(tx)),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MemberDuplicatesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(MemberDuplicatesService);
  });

  it('offers both new fields in the merge preview', async () => {
    const preview = await service.previewMerge('org-1', 's1', 't1');
    const byField = new Map(preview.fields.map((f: any) => [f.field, f]));
    expect(byField.get('alternatePhone')).toMatchObject({
      sourceValue: '9811111111',
      targetValue: null,
      differs: true,
    });
    expect(byField.get('emergencyContactEmail')).toMatchObject({
      sourceValue: 'sita@example.com',
      targetValue: null,
      differs: true,
    });
  });

  it('copies source values only on an explicit source win', async () => {
    await service.executeMerge(
      'org-1',
      {
        sourceMemberId: 's1',
        targetMemberId: 't1',
        resolution: {
          alternatePhone: 'source',
          emergencyContactEmail: 'source',
        },
      } as any,
      'staff-1',
    );
    expect(tx.member.update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: expect.objectContaining({
        alternatePhone: '9811111111',
        emergencyContactEmail: 'sita@example.com',
      }),
    });
  });

  it('keeps target values when no resolution is given', async () => {
    await service.executeMerge(
      'org-1',
      { sourceMemberId: 's1', targetMemberId: 't1', resolution: {} } as any,
      'staff-1',
    );
    const targetUpdate = tx.member.update.mock.calls.find(
      (c: any) => c[0]?.where?.id === 't1',
    );
    expect(targetUpdate[0].data).not.toHaveProperty('alternatePhone');
    expect(targetUpdate[0].data).not.toHaveProperty('emergencyContactEmail');
  });

  it('still rejects unknown resolution fields', async () => {
    await expect(
      service.executeMerge(
        'org-1',
        {
          sourceMemberId: 's1',
          targetMemberId: 't1',
          resolution: { alternatePhone: 'source', invented: 'source' },
        } as any,
        'staff-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
