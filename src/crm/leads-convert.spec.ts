import { ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CommunicationsService } from '../communications/communications.service';
import { DomainEvent } from '../events/domain-events';
import { MembersService } from '../members/members.service';
import { PrismaService } from '../prisma/prisma.service';
import { LeadsService } from './leads.service';

/**
 * Lead conversion must be atomic: the member rows and the WON transition
 * commit together, so a failure can never leave an orphan member or an
 * unmarked lead. Concurrent converts serialize on the guarded claim and
 * all but one fail. (No Redis/DB needed.)
 */
describe('LeadsService.convert transaction', () => {
  let service: LeadsService;
  let prisma: {
    lead: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
    $transaction: jest.Mock;
  };
  let members: { create: jest.Mock };
  let events: { emit: jest.Mock };

  const lead = {
    id: 'lead-1',
    status: 'NEW',
    branchId: 'branch-1',
    firstName: 'Priya',
    lastName: 'Sharma',
    email: null,
    phone: '9999999999',
  };
  const member = {
    id: 'mem-1',
    primaryBranchId: 'branch-1',
    email: null,
    phone: '9999999999',
    firstName: 'Priya',
  };

  beforeEach(async () => {
    const tx = {
      lead: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ ...lead, status: 'WON' }),
      },
    };
    prisma = {
      lead: {
        updateMany: jest.fn(),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn((cb: (tx: unknown) => unknown) => cb(tx)),
    };
    members = { create: jest.fn().mockResolvedValue(member) };
    events = { emit: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        LeadsService,
        { provide: PrismaService, useValue: prisma },
        { provide: MembersService, useValue: members },
        { provide: CommunicationsService, useValue: {} },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(LeadsService);
    jest
      .spyOn(service as unknown as { getOne: jest.Mock }, 'getOne')
      .mockResolvedValue(lead);
  });

  it('creates the member and marks the lead WON in one transaction', async () => {
    const res = await service.convert('org-1', 'lead-1', {});
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(members.create).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({ primaryBranchId: 'branch-1' }),
      null,
      null,
      expect.anything(),
    );
    expect(res.member).toEqual(member);
    expect(res.lead.status).toBe('WON');
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvent.MemberCreated,
      expect.objectContaining({ memberId: 'mem-1' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      DomainEvent.LeadConverted,
      expect.objectContaining({ leadId: 'lead-1', memberId: 'mem-1' }),
    );
  });

  it('rejects a concurrent second conversion and emits nothing', async () => {
    const tx = {
      lead: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation((cb: (tx: unknown) => unknown) =>
      cb(tx),
    );
    await expect(service.convert('org-1', 'lead-1', {})).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(tx.lead.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rolls back the claim when member creation fails', async () => {
    members.create.mockRejectedValueOnce(new Error('db down'));
    await expect(service.convert('org-1', 'lead-1', {})).rejects.toThrow(
      'db down',
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});
