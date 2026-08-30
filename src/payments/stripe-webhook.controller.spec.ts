import { Test } from '@nestjs/testing';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { PaymentsService } from '../billing/payments.service';
import { ConfigService } from '@nestjs/config';
import {
  UnauthorizedException,
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let stripeService: StripeService;
  let paymentsService: PaymentsService;
  let configService: ConfigService;
  let logger: Logger;

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
    configService = moduleRef.get<ConfigService>(ConfigService);
    logger = moduleRef.get<Logger>(Logger);
  });

  describe('handleWebhook', () => {
    it('should return InternalServerErrorException when webhook secret is not configured', async () => {
      // Arrange
      configService.get.mockReturnValue(null);

      // Act
      try {
        await controller.handleWebhook({}, 'signature');
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(InternalServerErrorException);
        expect(error.message).toBe('Webhook secret not configured');
        return;
      }
      expect.fail('Expected InternalServerErrorException');
    });

    it('should throw BadRequestException when stripe-signature header is missing', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');

      // Act
      try {
        await controller.handleWebhook({}, undefined);
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(BadRequestException);
        expect(error.message).toBe('Missing stripe-signature header');
        return;
      }
      expect.fail('Expected BadRequestException');
    });

    it('should throw UnauthorizedException when webhook signature verification fails', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');
      stripeService.constructEvent.mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      // Act
      try {
        await controller.handleWebhook({}, 'signature');
      } catch (error) {
        // Assert
        expect(error).toBeInstanceOf(UnauthorizedException);
        expect(error.message).toContain('Webhook Error');
        return;
      }
      expect.fail('Expected UnauthorizedException');
    });

    it('should handle payment_intent.succeeded event and create payment record', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');
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
      stripeService.constructEvent.mockReturnValue(mockEvent);
      paymentsService.getOneByStripeIntentId.mockResolvedValue(null); // No existing payment

      // Act
      await controller.handleWebhook({}, 'signature');

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
      configService.get.mockReturnValue('whsec_123');
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
      stripeService.constructEvent.mockReturnValue(mockEvent);
      paymentsService.getOneByStripeIntentId.mockResolvedValue(null); // No existing payment

      // Act
      await controller.handleWebhook({}, 'signature');

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
      configService.get.mockReturnValue('whsec_123');
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
      stripeService.constructEvent.mockReturnValue(mockEvent);
      const existingPayment = { id: 'payment_1' };
      paymentsService.getOneByStripeIntentId.mockResolvedValue(existingPayment);

      // Act
      await controller.handleWebhook({}, 'signature');

      // Assert
      expect(paymentsService.createStripePayment).not.toHaveBeenCalled();
    });

    it('should log error and return success response when handling succeeded payment fails', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');
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
      stripeService.constructEvent.mockReturnValue(mockEvent);
      paymentsService.getOneByStripeIntentId.mockResolvedValue(null);
      paymentsService.createStripePayment.mockRejectedValue(
        new Error('Database error'),
      );

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'error');

      // Act
      const result = await controller.handleWebhook({}, 'signature');

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to handle succeeded payment intent pi_999: Database error',
      );
      expect(result).toEqual({ received: true });
    });

    it('should log error and return success response when handling failed payment fails', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');
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
      stripeService.constructEvent.mockReturnValue(mockEvent);
      paymentsService.getOneByStripeIntentId.mockResolvedValue(null);
      paymentsService.createStripePayment.mockRejectedValue(
        new Error('Database error'),
      );

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'error');

      // Act
      const result = await controller.handleWebhook({}, 'signature');

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Failed to handle failed payment intent pi_888: Database error',
      );
      expect(result).toEqual({ received: true });
    });

    it('should log unhandled event types', async () => {
      // Arrange
      configService.get.mockReturnValue('whsec_123');
      const mockEvent = {
        type: 'charge.succeeded',
        data: {
          object: {},
        },
      };
      stripeService.constructEvent.mockReturnValue(mockEvent);

      // Spy on the controller's logger
      const logSpy = jest.spyOn(controller['logger'], 'log');

      // Act
      await controller.handleWebhook({}, 'signature');

      // Assert
      expect(logSpy).toHaveBeenCalledWith(
        'Unhandled event type charge.succeeded',
      );
    });
  });
});
