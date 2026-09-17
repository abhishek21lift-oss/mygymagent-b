import { Test } from '@nestjs/testing';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { PaymentsService } from '../billing/payments.service';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let stripeService: StripeService;
  let paymentsService: PaymentsService;
  let prismaService: PrismaService;
  let configService: ConfigService;
  let _logger: Logger;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        {
          provide: StripeService,
          useValue: {
            constructEvent: jest.fn(),
          },
        },
        {
          provide: PaymentsService,
          useValue: {
            getOneByStripeIntentId: jest.fn(),
            createStripePayment: jest.fn(),
          },
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn(),
          },
        },
        {
          provide: PrismaService,
          useValue: {
            member: { findFirst: jest.fn() },
            membership: { findFirst: jest.fn() },
          },
        },
        {
          provide: Logger,
          useValue: {
            log: jest.fn(),
            error: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = moduleRef.get<StripeWebhookController>(
      StripeWebhookController,
    );
    stripeService = moduleRef.get<StripeService>(StripeService);
    paymentsService = moduleRef.get<PaymentsService>(PaymentsService);
    prismaService = moduleRef.get<PrismaService>(PrismaService);
    configService = moduleRef.get<ConfigService>(ConfigService);
    _logger = moduleRef.get<Logger>(Logger);

    // Default: referenced member/membership belong to the metadata org.
    (prismaService.member.findFirst as jest.Mock).mockResolvedValue({
      id: 'member_1',
    });
    (prismaService.membership.findFirst as jest.Mock).mockResolvedValue({
      id: 'membership_1',
    });
  });

  describe('handleWebhook', () => {
    it('should return ServiceUnavailableException when webhook secret is not configured', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue(null);

      // Act
      try {
        await controller.handleWebhook(
          { rawBody: Buffer.from('{}') } as any,
          'signature',
        );
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(ServiceUnavailableException);
        expect(error.message).toBe('Webhook secret not configured');
        return;
      }
      throw new Error('Expected ServiceUnavailableException');
    });

    it('should throw BadRequestException when stripe-signature header is missing', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');

      // Act
      try {
        await controller.handleWebhook(
          { rawBody: Buffer.from('{}') } as any,
          '',
        );
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('Missing stripe-signature header');
        return;
      }
      throw new Error('Expected BadRequestException');
    });

    it('should throw UnauthorizedException when webhook signature verification fails', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      // Act
      try {
        await controller.handleWebhook(
          { rawBody: Buffer.from('{}') } as any,
          'signature',
        );
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toContain('Webhook Error');
        return;
      }
      throw new Error('Expected UnauthorizedException');
    });

    it('should handle payment_intent.succeeded event and create payment record', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_123',
            amount: 1000,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
              memberId: 'member_1',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        null,
      ); // No existing payment

      // Act
      await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
        'org_1',
        1000,
        'USD',
        'member_1',
        undefined,
        'pi_123',
        'user_1',
        'COMPLETED',
      );
    });

    it('should handle payment_intent.payment_failed event and create payment record with FAILED status', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_456',
            amount: 2000,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
              membershipId: 'membership_1',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        null,
      ); // No existing payment

      // Act
      await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
        'org_1',
        2000,
        'USD',
        undefined,
        'membership_1',
        'pi_456',
        'user_1',
        'FAILED',
      );
    });

    it('should not create duplicate payment if one already exists for the stripePaymentIntentId', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_789',
            amount: 1500,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
              memberId: 'member_1',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      const existingPayment = { id: 'payment_1' };
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        existingPayment,
      );

      // Act
      await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(paymentsService.createStripePayment).not.toHaveBeenCalled();
    });

    it('should log error and return success response when handling succeeded payment fails', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_999',
            amount: 1000,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        null,
      );
      (paymentsService.createStripePayment as jest.Mock).mockRejectedValue(
        new Error('Database error'),
      );

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'error');

      // Act
      const result = await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to handle succeeded payment intent pi_999: Database error',
      );
      expect(result).toEqual({ received: true });
    });

    it('should log error and return success response when handling failed payment fails', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.payment_failed',
        data: {
          object: {
            id: 'pi_888',
            amount: 1000,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        null,
      );
      (paymentsService.createStripePayment as jest.Mock).mockRejectedValue(
        new Error('Database error'),
      );

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'error');

      // Act
      const result = await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to handle failed payment intent pi_888: Database error',
      );
      expect(result).toEqual({ received: true });
    });

    it('should log unhandled event types', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'charge.succeeded',
        data: {
          object: {},
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'log');

      // Act
      await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Unhandled event type charge.succeeded',
      );
    });

    it('should ignore a payment whose member does not belong to the metadata org', async () => {
      // Arrange
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_foreign',
            amount: 1000,
            currency: 'usd',
            metadata: {
              organizationId: 'org_1',
              userId: 'user_1',
              memberId: 'member_other_org',
            },
          },
        },
      };
      (stripeService.constructEvent as jest.Mock).mockReturnValue(mockEvent);
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(
        null,
      );
      (prismaService.member.findFirst as jest.Mock).mockResolvedValue(null);

      // Act
      const result = await controller.handleWebhook(
        { rawBody: Buffer.from('{}') } as any,
        'signature',
      );

      // Assert
      expect(paymentsService.createStripePayment).not.toHaveBeenCalled();
      expect(result).toEqual({ received: true });
    });
  });
});
