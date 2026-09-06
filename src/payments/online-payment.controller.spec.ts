import { Test } from '@nestjs/testing';
import { OnlinePaymentController } from './online-payment.controller';
import { StripeService } from './stripe.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';

describe('OnlinePaymentController', () => {
  let controller: OnlinePaymentController;
  let stripeService: StripeService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OnlinePaymentController],
      providers: [
        { provide: StripeService, useValue: { createPaymentIntent: jest.fn() } },
        {
          provide: PrismaService,
          useValue: {
            member: { findFirst: jest.fn() },
            membership: { findFirst: jest.fn() },
          },
        },
      ],
    }).compile();

    controller = moduleRef.get(OnlinePaymentController);
    stripeService = moduleRef.get(StripeService);
    prisma = moduleRef.get(PrismaService);
  });

  describe('createPaymentIntent', () => {
    const mockUser = {
      id: 'user_1', organizationId: 'org_1', email: 'test@example.com',
    } as AuthenticatedUser;

    const mockDto: CreateOnlinePaymentIntentDto = {
      amount: 1000, currency: 'usd', description: 'Test payment',
      memberId: 'member_1', membershipId: 'membership_1',
    };

    beforeEach(() => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue({ id: 'member_1' });
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ id: 'membership_1', memberId: 'member_1' });
    });

    it('rejects users without an organization', async () => {
      await expect(controller.createPaymentIntent(
        { ...mockUser, organizationId: null } as any, 'key', mockDto,
      )).rejects.toMatchObject({
        constructor: UnauthorizedException,
        message: 'User must belong to an organization to create payment intents',
      });
    });

    it('rejects missing payment target', async () => {
      await expect(controller.createPaymentIntent(
        mockUser, 'key', { ...mockDto, memberId: undefined, membershipId: undefined },
      )).rejects.toMatchObject({ constructor: BadRequestException });
    });

    it('rejects non-positive or non-integer amounts', async () => {
      for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        await expect(controller.createPaymentIntent(
          mockUser, 'key', { ...mockDto, amount },
        )).rejects.toMatchObject({ constructor: BadRequestException });
      }
    });

    it('rejects a member outside the current organization', async () => {
      (prisma.member.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(controller.createPaymentIntent(mockUser, 'key', mockDto))
        .rejects.toMatchObject({ constructor: NotFoundException, message: 'Member not found' });
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects a membership outside the current organization', async () => {
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(controller.createPaymentIntent(mockUser, 'key', mockDto))
        .rejects.toMatchObject({ constructor: NotFoundException, message: 'Membership not found' });
      expect(stripeService.createPaymentIntent).not.toHaveBeenCalled();
    });

    it('rejects a membership belonging to another member', async () => {
      (prisma.membership.findFirst as jest.Mock).mockResolvedValue({ id: 'membership_1', memberId: 'member_2' });
      await expect(controller.createPaymentIntent(mockUser, 'key', mockDto))
        .rejects.toMatchObject({ constructor: BadRequestException });
    });

    it('creates an intent with validated tenant-scoped metadata', async () => {
      (stripeService.createPaymentIntent as jest.Mock).mockResolvedValue({ client_secret: 'secret_123', id: 'pi_123' });
      await expect(controller.createPaymentIntent(mockUser, 'idempotency-key', mockDto))
        .resolves.toEqual({ clientSecret: 'secret_123', id: 'pi_123' });
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(1000, 'usd', {
        organizationId: 'org_1', userId: 'user_1', memberId: 'member_1',
        membershipId: 'membership_1', description: 'Test payment',
      }, 'idempotency-key');
    });

    it('derives memberId from membership when only membershipId is provided', async () => {
      (stripeService.createPaymentIntent as jest.Mock).mockResolvedValue({ client_secret: 'secret', id: 'pi_2' });
      await controller.createPaymentIntent(mockUser, 'key', { ...mockDto, memberId: undefined });
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(1000, 'usd', expect.objectContaining({ memberId: 'member_1' }), 'key');
    });

    it('uses USD when currency is omitted', async () => {
      (stripeService.createPaymentIntent as jest.Mock).mockResolvedValue({ client_secret: 'secret', id: 'pi_3' });
      await controller.createPaymentIntent(mockUser, 'key', { ...mockDto, currency: undefined });
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(1000, 'usd', expect.any(Object), 'key');
    });

    it('maps Stripe failures to InternalServerErrorException', async () => {
      (stripeService.createPaymentIntent as jest.Mock).mockRejectedValue(new Error('Stripe error'));
      await expect(controller.createPaymentIntent(mockUser, 'key', mockDto))
        .rejects.toMatchObject({ constructor: InternalServerErrorException, message: 'Failed to create payment intent' });
    });
  });
});
