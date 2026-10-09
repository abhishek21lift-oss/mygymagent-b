import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { BusinessOsService } from './business-os.service';

function service(prisma: Record<string, unknown>) {
  return new BusinessOsService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('BusinessOsService branch scoping', () => {
  it.each([
    [
      'loyaltyAccount',
      (s: BusinessOsService) => s.loyaltyAccount('o1', 'm1', 'br-1'),
    ],
    [
      'loyaltyAdjust',
      (s: BusinessOsService) =>
        s.loyaltyAdjust('o1', 'u1', 'm1', 5, 'x', 'br-1'),
    ],
    [
      'createReferral',
      (s: BusinessOsService) => s.createReferral('o1', 'm1', 'br-1'),
    ],
    [
      'convertReferral',
      (s: BusinessOsService) => s.convertReferral('o1', 'r1', 'm1', 'br-1'),
    ],
    [
      'ptIntelligence',
      (s: BusinessOsService) => s.ptIntelligence('o1', 'm1', 'br-1'),
    ],
  ])('%s 404s a member outside the caller branch', async (_name, call) => {
    const prisma = {
      member: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    await expect(call(service(prisma))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.member.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ id: 'm1', primaryBranchId: 'br-1' }),
    );
  });

  it('filters referrals, tickets and campaigns to the caller branch', async () => {
    const prisma = {
      referral: { findMany: jest.fn().mockResolvedValue([]) },
      member: { findMany: jest.fn().mockResolvedValue([]) },
      supportTicket: { findMany: jest.fn().mockResolvedValue([]) },
      marketingCampaign: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const svc = service(prisma);
    await svc.referrals('o1', 'br-1');
    await svc.tickets('o1', undefined, 'br-1');
    await svc.campaigns('o1', 'br-1');
    expect(prisma.referral.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'o1',
      referrerMember: { primaryBranchId: 'br-1' },
    });
    expect(prisma.supportTicket.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'o1',
      branchId: 'br-1',
    });
    expect(prisma.marketingCampaign.findMany.mock.calls[0][0].where).toEqual({
      organizationId: 'o1',
      branchId: 'br-1',
    });
  });

  it('404s another branch ticket on read, reply and status change', async () => {
    const prisma = {
      supportTicket: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const svc = service(prisma);
    await expect(svc.ticketMessages('o1', 't1', 'br-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      svc.addTicketMessage('o1', 'u1', 't1', 'hi', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      svc.updateTicket('o1', 't1', 'CLOSED', 'br-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    for (const [args] of prisma.supportTicket.findFirst.mock.calls) {
      expect(args.where).toEqual({
        id: 't1',
        organizationId: 'o1',
        branchId: 'br-1',
      });
    }
  });

  it('refuses a ticket or campaign naming another branch', async () => {
    const svc = service({});
    await expect(
      svc.createTicket(
        'o1',
        'u1',
        { subject: 's', description: 'd', branchId: 'br-2' } as never,
        'br-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.createCampaign(
        'o1',
        { name: 'n', branchId: 'br-2' } as never,
        'br-1',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('pins a campaign audience to the caller branch', async () => {
    const prisma = {
      marketingCampaign: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'c1', audienceFilter: {} }),
      },
      member: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      marketingCampaignMember: { count: jest.fn().mockResolvedValue(0) },
    };
    await service(prisma).previewCampaign('o1', 'c1', 'br-1');
    expect(prisma.marketingCampaign.findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ branchId: 'br-1' }),
    );
    expect(prisma.member.count.mock.calls[0][0].where.AND).toContainEqual({
      primaryBranchId: 'br-1',
    });
  });

  it.each([
    ['accounts', (s: BusinessOsService) => s.accounts('o1', 'br-1')],
    [
      'createAccount',
      (s: BusinessOsService) =>
        s.createAccount('o1', { code: '1', name: 'n' } as never, 'br-1'),
    ],
    [
      'accountingJournal',
      (s: BusinessOsService) =>
        s.accountingJournal('o1', 'u1', { lines: [] } as never, 'br-1'),
    ],
    ['entries', (s: BusinessOsService) => s.entries('o1', {}, 'br-1')],
    [
      'taxSummary',
      (s: BusinessOsService) =>
        s.taxSummary('o1', undefined, undefined, 'br-1'),
    ],
    [
      'trialBalance',
      (s: BusinessOsService) =>
        s.trialBalance('o1', undefined, undefined, 'br-1'),
    ],
    [
      'createSurvey',
      (s: BusinessOsService) =>
        s.createSurvey('o1', { name: 'n' } as never, 'br-1'),
    ],
  ])('%s is refused (403) for a branch-scoped caller', async (_name, call) => {
    await expect((async () => call(service({})))()).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
