import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MemberOtpService } from './member-otp.service';
import { OTP_DELIVERY } from './otp-delivery/otp-delivery.interface';

/**
 * D-DB02 (F-DB02): OTP request prefers an exact digit match before the
 * global suffix match, so a number stored exactly as typed resolves to
 * its own row even when another organization's member shares the suffix.
 * Multiples still fail closed; formatted-only numbers keep the suffix
 * path. Mocked Prisma + delivery (no database, no SMS).
 */
describe('MemberOtpService requestCode matching (D-DB02)', () => {
  let service: MemberOtpService;
  let prisma: any;
  let delivery: any;

  const findMany = jest.fn();
  let rows: Array<{ id: string; phone: string; organizationId: string }>;

  beforeEach(async () => {
    findMany.mockReset();
    findMany.mockImplementation(async (args: any) => {
      const phoneWhere = args?.where?.phone;
      if (typeof phoneWhere === 'string')
        return rows.filter((r) => r.phone === phoneWhere).slice(0, 2);
      if (phoneWhere?.endsWith)
        return rows
          .filter((r) =>
            r.phone.replace(/\D/g, '').endsWith(phoneWhere.endsWith),
          )
          .slice(0, 2);
      return [];
    });
    prisma = {
      member: { findMany },
      memberOtpChallenge: {
        findFirst: jest.fn().mockResolvedValue(null),
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'ch-1' }),
      },
    };
    delivery = {
      providerName: 'mock' as const,
      isConfigured: jest.fn().mockReturnValue(true),
      issueCode: jest.fn().mockReturnValue('123456'),
      send: jest.fn().mockResolvedValue(undefined),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        MemberOtpService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: { record: jest.fn() } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue(300) },
        },
        { provide: OTP_DELIVERY, useValue: delivery },
      ],
    }).compile();
    service = moduleRef.get(MemberOtpService);
  });

  it('exact-digit row wins over a cross-org suffix collision', async () => {
    rows = [
      { id: 'exact-1', phone: '919876543210', organizationId: 'org-a' },
      { id: 'other-1', phone: '+15559876543210', organizationId: 'org-b' },
    ];
    const res = await service.requestCode('919876543210', {});
    expect(res).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(prisma.memberOtpChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: 'exact-1' }),
      }),
    );
  });

  it('formatted-only numbers still resolve through the suffix path', async () => {
    rows = [{ id: 'fmt-1', phone: '+91 98765 43210', organizationId: 'org-a' }];
    await service.requestCode('919876543210', {});
    expect(prisma.memberOtpChallenge.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ memberId: 'fmt-1' }),
      }),
    );
  });

  it('two exact matches still fail closed without issuing', async () => {
    rows = [
      { id: 'dup-1', phone: '919876543210', organizationId: 'org-a' },
      { id: 'dup-2', phone: '919876543210', organizationId: 'org-a' },
    ];
    const res = await service.requestCode('919876543210', {});
    expect(res).toEqual({ sent: true, expiresInSeconds: 300 });
    expect(prisma.memberOtpChallenge.create).not.toHaveBeenCalled();
  });
});
