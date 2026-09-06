import { Test } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException, NotFoundException } from '@nestjs/common';

describe('PaymentsService', () => {
  let service: PaymentsService;
  let prisma: PrismaService;
  let events: EventEmitter2;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        PaymentsService,
        {
          provide: PrismaService,
          useValue: {
            payment: { findFirst: jest.fn(), create: jest.fn(), findMany: jest.fn(), count: jest.fn(), groupBy: jest.fn() },
            membership: { findFirst: jest.fn(), findMany: jest.fn() },
            member: { findFirst: jest.fn() },
            refund: { findMany: jest.fn() },
            aiUsageLog: { create: jest.fn() },
            $queryRaw: jest.fn(),
          },
        },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();
    service = moduleRef.get(PaymentsService);
    prisma = moduleRef.get(PrismaService);
    events = moduleRef.get(EventEmitter2);
  });

  describe('getOneByStripeIntentId', () => {
    it('returns a payment if found', async () => {
      const mockPayment = { id: 'payment_1', stripePaymentIntentId: 'pi_123' };
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);
      await expect(service.getOneByStripeIntentId('pi_123')).resolves.toEqual(mockPayment);
      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_123' },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          membership: { include: { membershipPlan: true } },
          refunds: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    it('returns null when not found', async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.getOneByStripeIntentId('pi_nonexistent')).resolves.toBeNull();
    });
  });

  describe('createStripePayment', () => {
    const basePayment = { id: 'payment_1' };

    it('creates a payment record with validated member and membership', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member_1', primaryBranchId: 'branch_1' });
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ id: 'membership_1', memberId: 'member_1', branchId: 'branch_1' });
      (prisma.payment.create as jest.Mock).mockResolvedValue(basePayment);

      await expect(service.createStripePayment('org_1', 1000, 'USD', 'member_1', 'membership_1', 'pi_123', 'user_1', 'COMPLETED'))
        .resolves.toEqual(basePayment);
      expect(prisma.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({
        organizationId: 'org_1', branchId: 'branch_1', memberId: 'member_1', membershipId: 'membership_1',
        amount: 1000, currency: 'USD', method: 'CARD', status: 'COMPLETED', stripePaymentIntentId: 'pi_123', recordedByUserId: 'user_1',
      }) });
      expect(events.emit).toHaveBeenCalled();
    });

    it('derives member and branch from membership when only membershipId is provided', async () => {
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ id: 'membership_1', memberId: 'member_1', branchId: 'branch_1' });
      (prisma.payment.create as jest.Mock).mockResolvedValue(basePayment);

      await service.createStripePayment('org_1', 1000, 'USD', undefined, 'membership_1', 'pi_123', 'user_1', 'COMPLETED');

      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { id: 'membership_1', organizationId: 'org_1' },
        select: { id: true, memberId: true, branchId: true },
      });
      expect(prisma.payment.create).toHaveBeenCalledWith({ data: expect.objectContaining({ memberId: 'member_1', branchId: 'branch_1' }) });
    });

    it('rejects when member does not exist in the organization', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(service.createStripePayment('org_1', 1000, 'USD', 'member_1', undefined, 'pi_123', 'user_1', 'COMPLETED'))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });

    it('rejects a membership that belongs to another member', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member_1', primaryBranchId: 'branch_1' });
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ id: 'membership_1', memberId: 'member_2', branchId: 'branch_1' });
      await expect(service.createStripePayment('org_1', 1000, 'USD', 'member_1', 'membership_1', 'pi_123', 'user_1', 'COMPLETED'))
        .rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when neither member nor membership identifies a payment target', async () => {
      await expect(service.createStripePayment('org_1', 1000, 'USD', undefined, undefined, 'pi_123', 'user_1', 'COMPLETED'))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payment.create).not.toHaveBeenCalled();
    });
  });
});
