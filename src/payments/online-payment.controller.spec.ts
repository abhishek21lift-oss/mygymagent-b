import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { OnlinePaymentController } from './online-payment.controller';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';
import { Decimal } from '@prisma/client/runtime/library';

/** Minimal Decimal-like amounts for the mocked Prisma results. */
const D = (n: number) => new Decimal(n);

describe('OnlinePaymentController', () => {
  let controller: OnlinePaymentController;
  let stripeService: { createPaymentIntent: jest.Mock };
  let prisma: Record<string, Record<string, jest.Mock>>;

  const membershipId = '00000000-0000-0000-0000-000000000001';

  const mockUser = {
    id: 'user_1',
    organizationId: 'org_1',
  } as any as AuthenticatedUser;

  const dto: CreateOnlinePaymentIntentDto = {
    membershipId,
    description: 'Test payment',
  };

  const mockMembership = {
    id: membershipId,
    memberId: 'member_1',
    price: D(150),
    currency: 'USD',
    membershipPlan: { id: 'plan_1' },
  };

  const mockMember = { id: 'member_1', primaryBranchId: 'branch_1' };

  beforeEach(async () => {
    stripeService = { createPaymentIntent: jest.fn() };
    prisma = {
      membership: { findFirst: jest.fn().mockResolvedValue(mockMembership) },
      member: { findFirst: jest.fn().mockResolvedValue(mockMember) },
      payment: { findMany: jest.fn().mockResolvedValue([]) },
      refund: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [OnlinePaymentController],
      providers: [
        { provide: StripeService, useValue: stripeService },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    controller = moduleRef.get(OnlinePaymentController);
  });

  it('throws Unauthorized if the user has no organization', async () => {
    await expect(
      controller.createPaymentIntent(
        { ...mockUser, organizationId: null } as any,
        'key',
        dto,
      ),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('throws NotFound for a membership outside the org', async () => {
    prisma.membership.findFirst.mockResolvedValue(null);
    await expect(
      controller.createPaymentIntent(mockUser, 'key', dto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws NotFound when the membership member is missing', async () => {
    prisma.member.findFirst.mockResolvedValue(null);
    await expect(
      controller.createPaymentIntent(mockUser, 'key', dto),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequest when nothing is outstanding', async () => {
    // Fully paid: 150 due, 150 paid.
    prisma.payment.findMany.mockResolvedValue([
      { id: 'pay_1', amount: D(150) },
    ]);
    prisma.refund.findMany.mockResolvedValue([]);
    await expect(
      controller.createPaymentIntent(mockUser, 'key', dto),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('derives the amount server-side and charges cents', async () => {
    // 150 due, 50 paid, 20 refunded -> outstanding 120 -> 12000 cents.
    prisma.payment.findMany.mockResolvedValue([{ id: 'pay_1', amount: D(50) }]);
    prisma.refund.findMany.mockResolvedValue([{ amount: D(20) }]);
    stripeService.createPaymentIntent.mockResolvedValue({
      id: 'pi_123',
      client_secret: 'secret_123',
    });

    const result = await controller.createPaymentIntent(
      mockUser,
      'idempotency-key',
      dto,
    );

    expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
      12000,
      'usd',
      {
        organizationId: 'org_1',
        userId: 'user_1',
        memberId: 'member_1',
        membershipId,
        description: 'Test payment',
      },
      'idempotency-key',
    );
    expect(result).toEqual({
      clientSecret: 'secret_123',
      id: 'pi_123',
      amount: 12000,
    });
  });

  it('accounts refunds against partial refunds when deriving balance', async () => {
    // 150 due, 100 paid, 30 refunded -> outstanding 80 -> 8000 cents.
    prisma.payment.findMany.mockResolvedValue([
      { id: 'pay_1', amount: D(100) },
    ]);
    prisma.refund.findMany.mockResolvedValue([{ amount: D(30) }]);
    stripeService.createPaymentIntent.mockResolvedValue({
      id: 'pi_1',
      client_secret: 's',
    });

    await controller.createPaymentIntent(mockUser, 'key', dto);
    expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
      8000,
      expect.any(String),
      expect.objectContaining({ membershipId }),
      'key',
    );
  });

  it('maps a Stripe failure to InternalServerError', async () => {
    prisma.payment.findMany.mockResolvedValue([{ id: 'pay_1', amount: D(50) }]);
    prisma.refund.findMany.mockResolvedValue([]);
    stripeService.createPaymentIntent.mockRejectedValue(
      new Error('Stripe error'),
    );

    await expect(
      controller.createPaymentIntent(mockUser, 'key', dto),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
