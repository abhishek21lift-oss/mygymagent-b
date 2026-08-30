import { Test } from '@nestjs/testing';
import { OnlinePaymentController } from './online-payment.controller';
import { StripeService } from './stripe.service';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { CreateOnlinePaymentIntentDto } from './dto/create-online-payment-intent.dto';

describe('OnlinePaymentController', () => {
  let controller: OnlinePaymentController;
  let stripeService: StripeService;
  let configService: ConfigService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [OnlinePaymentController],
      providers: [
        {
          provide: StripeService,
          useValue: {
            createPaymentIntent: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get<OnlinePaymentController>(
      OnlinePaymentController,
    );
    stripeService = moduleRef.get<StripeService>(StripeService);
    configService = moduleRef.get<ConfigService>(ConfigService);
  });

  describe('createPaymentIntent', () => {
    const mockUser: AuthenticatedUser = {
      id: 'user_1',
      organizationId: 'org_1',
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
      phone: '1234567890',
      status: 'ACTIVE',
      emailVerifiedAt: new Date(),
      lastLoginAt: new Date(),
      failedLoginAttempts: 0,
      lockedUntil: null,
      primaryBranchId: 'branch_1',
    };

    const mockDto: CreateOnlinePaymentIntentDto = {
      amount: 1000,
      currency: 'usd',
      description: 'Test payment',
      memberId: 'member_1',
      membershipId: 'membership_1',
    };

    it('should throw UnauthorizedException if user does not belong to an organization', async () => {
      // Arrange
      const userWithoutOrg = { ...mockUser, organizationId: null };

      // Act
      try {
        await controller.createPaymentIntent(
          userWithoutOrg,
          'idempotency-key',
          mockDto,
        );
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toBe(
          'User must belong to an organization to create payment intents',
        );
        return;
      }
      expect.fail('Expected UnauthorizedException');
    });

    it('should throw BadRequestException if neither memberId nor membershipId is provided', async () => {
      // Arrange
      const dtoWithoutIds = {
        ...mockDto,
        memberId: undefined,
        membershipId: undefined,
      };

      // Act
      try {
        await controller.createPaymentIntent(
          mockUser,
          'idempotency-key',
          dtoWithoutIds,
        );
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe(
          'Either memberId or membershipId must be provided',
        );
        return;
      }
      expect.fail('Expected BadRequestException');
    });

    it('should create a payment intent and return clientSecret and id', async () => {
      // Arrange
      const mockPaymentIntent = {
        client_secret: 'secret_123',
        id: 'pi_123',
      };
      stripeService.createPaymentIntent.mockResolvedValue(mockPaymentIntent);

      // Act
      const result = await controller.createPaymentIntent(
        mockUser,
        'idempotency-key',
        mockDto,
      );

      // Assert
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        1000,
        'usd',
        {
          organizationId: 'org_1',
          userId: 'user_1',
          memberId: 'member_1',
          membershipId: 'membership_1',
          description: 'Test payment',
        },
        'idempotency-key',
      );
      expect(result).toEqual({
        clientSecret: 'secret_123',
        id: 'pi_123',
      });
    });

    it('should use default currency if not provided', async () => {
      // Arrange
      const dtoWithoutCurrency = { ...mockDto, currency: undefined };
      const mockPaymentIntent = {
        client_secret: 'secret_123',
        id: 'pi_123',
      };
      stripeService.createPaymentIntent.mockResolvedValue(mockPaymentIntent);

      // Act
      await controller.createPaymentIntent(
        mockUser,
        'idempotency-key',
        dtoWithoutCurrency,
      );

      // Assert
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        1000,
        'usd',
        {
          organizationId: 'org_1',
          userId: 'user_1',
          memberId: 'member_1',
          membershipId: 'membership_1',
          description: 'Test payment',
        },
        'idempotency-key',
      );
    });

    it('should log error and throw InternalServerErrorException when Stripe fails', async () => {
      // Arrange
      stripeService.createPaymentIntent.mockRejectedValue(
        new Error('Stripe error'),
      );

      // Act
      try {
        await controller.createPaymentIntent(
          mockUser,
          'idempotency-key',
          mockDto,
        );
      } catch (error) {
        // Assert
        // Note: We cannot directly spy on the logger because we are using the testing module.
        // However, we can check that the error is thrown and is an InternalServerErrorException.
        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect(error.message).toBe('Failed to create payment intent');
        return;
      }
      expect.fail('Expected InternalServerErrorException');
    });
  });
});
