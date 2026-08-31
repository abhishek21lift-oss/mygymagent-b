import { Test } from '@nestjs/testing';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { NotFoundException } from '@nestjs/common';
import type { CreatePaymentDto } from './dto/create-payment.dto';
import type { RefundPaymentDto } from './dto/refund-payment.dto';

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
            payment: {
              findFirst: jest.fn(),
              create: jest.fn(),
              findMany: jest.fn(),
              count: jest.fn(),
              groupBy: jest.fn(),
            },
            membership: {
              findFirst: jest.fn(),
              findMany: jest.fn(),
            },
            member: {
              findFirst: jest.fn(),
            },
            refund: {
              findMany: jest.fn(),
            },
            aiUsageLog: {
              create: jest.fn(),
            },
            $queryRaw: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = moduleRef.get<PaymentsService>(PaymentsService);
    prisma = moduleRef.get<PrismaService>(PrismaService);
    events = moduleRef.get<EventEmitter2>(EventEmitter2);
  });

  describe('getOneByStripeIntentId', () => {
    it('should return a payment if found', async () => {
      const mockPayment = { id: 'payment_1', stripePaymentIntentId: 'pi_123' };
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.getOneByStripeIntentId('pi_123');

      expect(result).toEqual(mockPayment);
      expect(prisma.payment.findFirst).toHaveBeenCalledWith({
        where: { stripePaymentIntentId: 'pi_123' },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          membership: { include: { membershipPlan: true } },
          refunds: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    it('should return null if no payment found', async () => {
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.getOneByStripeIntentId('pi_nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('createStripePayment', () => {
    it('should create a payment record with correct data', async () => {
      const mockPayment = { id: 'payment_1' };
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.createStripePayment(
        'org_1',
        1000,
        'USD',
        'member_1',
        'membership_1',
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(result).toEqual(mockPayment);
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org_1',
          branchId: null, // Will be determined by logic
          memberId: 'member_1',
          membershipId: 'membership_1',
          amount: 1000,
          currency: 'USD',
          method: 'CARD',
          status: 'COMPLETED',
          stripePaymentIntentId: 'pi_123',
          recordedByUserId: 'user_1',
        },
      });
    });

    it('should determine branchId from membership when provided', async () => {
      const mockPayment = { id: 'payment_1' };
      const mockMembership = { branchId: 'branch_1' };
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
        mockMembership,
      );
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      await service.createStripePayment(
        'org_1',
        1000,
        'USD',
        undefined,
        'membership_1',
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { id: 'membership_1', organizationId: 'org_1' },
        select: { branchId: true },
      });
    });

    it('should determine branchId from member when membership not provided', async () => {
      const mockPayment = { id: 'payment_1' };
      const mockMember = { primaryBranchId: 'branch_2' };
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      await service.createStripePayment(
        'org_1',
        1000,
        'USD',
        'member_1',
        undefined,
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(prisma.member.findFirst).toHaveBeenCalledWith({
        where: { id: 'member_1', organizationId: 'org_1' },
        select: { primaryBranchId: true },
      });
    });

    it('should set branchId to null when neither member nor membership provided', async () => {
      const mockPayment = { id: 'payment_1' };
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      await service.createStripePayment(
        'org_1',
        1000,
        'USD',
        undefined,
        undefined,
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org_1',
          branchId: null,
          memberId: undefined,
          membershipId: undefined,
          amount: 1000,
          currency: 'USD',
          method: 'CARD',
          status: 'COMPLETED',
          stripePaymentIntentId: 'pi_123',
          recordedByUserId: 'user_1',
        },
      });
    });
  });
});
