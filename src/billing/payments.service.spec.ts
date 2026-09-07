import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PaymentsService } from './payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DomainEvent } from '../events/domain-events';

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
    const mockMember = { id: 'member_1', primaryBranchId: 'branch_2' };
    const mockMembership = {
      id: 'membership_1',
      memberId: 'member_1',
      branchId: 'branch_1',
    };

    it('creates a payment scoped to the tenant-checked member/membership', async () => {
      const mockPayment = {
        id: 'payment_1',
        status: 'COMPLETED',
        branchId: 'branch_1',
        memberId: 'member_1',
        membershipId: 'membership_1',
        amount: new Prisma.Decimal(10),
        currency: 'USD',
      };
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
        mockMembership,
      );
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      const result = await service.createStripePayment(
        'org_1',
        10,
        'USD',
        'member_1',
        'membership_1',
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(result).toEqual(mockPayment);
      expect(prisma.member.findFirst).toHaveBeenCalledWith({
        where: {
          id: 'member_1',
          organizationId: 'org_1',
          deletedAt: null,
        },
        select: { id: true, primaryBranchId: true },
      });
      expect(prisma.membership.findFirst).toHaveBeenCalledWith({
        where: { id: 'membership_1', organizationId: 'org_1' },
        select: { id: true, memberId: true, branchId: true },
      });
      expect(prisma.payment.create).toHaveBeenCalledWith({
        data: {
          organizationId: 'org_1',
          branchId: 'branch_1', // from the membership
          memberId: 'member_1',
          membershipId: 'membership_1',
          amount: 10,
          currency: 'USD',
          method: 'CARD',
          status: 'COMPLETED',
          stripePaymentIntentId: 'pi_123',
          recordedByUserId: 'user_1',
        },
      });
    });

    it('emits PaymentRecorded for a completed payment', async () => {
      const mockPayment = {
        id: 'payment_1',
        status: 'COMPLETED',
        branchId: 'branch_1',
        memberId: 'member_1',
        membershipId: 'membership_1',
        amount: new Prisma.Decimal(10),
        currency: 'USD',
      };
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
        mockMembership,
      );
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      await service.createStripePayment(
        'org_1',
        10,
        'USD',
        'member_1',
        'membership_1',
        'pi_123',
        'user_1',
        'COMPLETED',
      );

      expect(events.emit).toHaveBeenCalledWith(
        DomainEvent.PaymentRecorded,
        expect.objectContaining({
          organizationId: 'org_1',
          paymentId: 'payment_1',
          memberId: 'member_1',
        }),
      );
    });

    it('does not emit PaymentRecorded for a FAILED payment', async () => {
      const mockPayment = {
        id: 'payment_1',
        status: 'FAILED',
        branchId: 'branch_1',
        memberId: 'member_1',
        membershipId: 'membership_1',
        amount: new Prisma.Decimal(10),
        currency: 'USD',
      };
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
        mockMembership,
      );
      (prisma.payment.create as jest.Mock).mockResolvedValue(mockPayment);

      await service.createStripePayment(
        'org_1',
        10,
        'USD',
        'member_1',
        'membership_1',
        'pi_123',
        'user_1',
        'FAILED',
      );

      expect(events.emit).not.toHaveBeenCalled();
    });

    it('resolves memberId from the membership when only a membershipId is given', async () => {
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(
        mockMembership,
      );
      (prisma.payment.create as jest.Mock).mockResolvedValue({
        id: 'payment_2',
        status: 'FAILED',
      });

      await service.createStripePayment(
        'org_1',
        10,
        'USD',
        undefined,
        'membership_1',
        'pi_456',
        'user_1',
        'FAILED',
      );

      expect(prisma.payment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            memberId: 'member_1', // from membership.memberId
            membershipId: 'membership_1',
            branchId: 'branch_1',
          }),
        }),
      );
    });

    it('throws NotFound when the member belongs to another org', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createStripePayment(
          'org_1',
          10,
          'USD',
          'member_1',
          undefined,
          'pi_123',
          'user_1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws NotFound when the membership belongs to another org', async () => {
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.createStripePayment(
          'org_1',
          10,
          'USD',
          undefined,
          'membership_1',
          'pi_123',
          'user_1',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('throws BadRequest when neither memberId nor membershipId is given', async () => {
      await expect(
        service.createStripePayment(
          'org_1',
          10,
          'USD',
          undefined,
          undefined,
          'pi_123',
          'user_1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('throws BadRequest when the membership belongs to a different member', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({
        ...mockMembership,
        memberId: 'member_OTHER',
      });

      await expect(
        service.createStripePayment(
          'org_1',
          10,
          'USD',
          'member_1',
          'membership_1',
          'pi_123',
          'user_1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('returns the existing row when a concurrent insert wins the stripePaymentIntentId unique race', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(mockMember);
      const existing = {
        id: 'payment_winner',
        stripePaymentIntentId: 'pi_123',
      };
      (prisma.payment.create as jest.Mock).mockImplementation(() => {
        const err = new (
          Prisma.PrismaClientKnownRequestError as new (
            message: string,
            args: { code: string; clientVersion: string },
          ) => Prisma.PrismaClientKnownRequestError
        )('Unique constraint failed', {
          code: 'P2002',
          clientVersion: '6.0.0',
        });
        throw err;
      });
      (prisma.payment.findFirst as jest.Mock).mockResolvedValue(existing);

      const result = await service.createStripePayment(
        'org_1',
        10,
        'USD',
        'member_1',
        undefined,
        'pi_123',
        'user_1',
      );

      expect(result).toEqual(existing);
    });
  });
});
