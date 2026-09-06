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

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let stripeService: StripeService;
  let paymentsService: PaymentsService;
  let configService: ConfigService;

  const request = (rawBody = '{}') =>
    ({ rawBody: Buffer.from(rawBody) }) as Parameters<
      StripeWebhookController['handleWebhook']
    >[0];

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        {
          provide: StripeService,
          useValue: { constructEvent: jest.fn() },
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
          useValue: { get: jest.fn() },
        },
      ],
    }).compile();

    controller = moduleRef.get<StripeWebhookController>(StripeWebhookController);
    stripeService = moduleRef.get<StripeService>(StripeService);
    paymentsService = moduleRef.get<PaymentsService>(PaymentsService);
    configService = moduleRef.get<ConfigService>(ConfigService);
  });

  describe('handleWebhook', () => {
    it('throws when webhook secret is not configured', async () => {
      (configService.get as jest.Mock).mockReturnValue(null);

      await expect(controller.handleWebhook(request(), 'signature')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('throws BadRequestException when stripe-signature header is missing', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');

      await expect(controller.handleWebhook(request(), '')).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('throws UnauthorizedException when webhook signature verification fails', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockImplementation(() => {
        throw new Error('Invalid signature');
      });

      await expect(
        controller.handleWebhook(request('{"event":"test"}'), 'signature'),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('uses the exact raw request body and creates a successful payment record', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      const rawBody = '{"id":"pi_123"}';
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
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(null);

      await controller.handleWebhook(request(rawBody), 'signature');

      expect(stripeService.constructEvent).toHaveBeenCalledWith(
        Buffer.from(rawBody),
        'signature',
        'whsec_123',
      );
      expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
        'org_1',
        10,
        'USD',
        'member_1',
        undefined,
        'pi_123',
        'user_1',
        'COMPLETED',
      );
    });

    it('converts zero-decimal currency amounts correctly', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockReturnValue({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_jpy',
            amount: 1000,
            currency: 'jpy',
            metadata: { organizationId: 'org_1', userId: 'user_1', memberId: 'member_1' },
          },
        },
      });
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(null);

      await controller.handleWebhook(request(), 'signature');

      expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
        'org_1',
        1000,
        'JPY',
        'member_1',
        undefined,
        'pi_jpy',
        'user_1',
        'COMPLETED',
      );
    });

    it('supports membership-only failed payments', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockReturnValue({
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
      });
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(null);

      await controller.handleWebhook(request(), 'signature');

      expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
        'org_1',
        20,
        'USD',
        undefined,
        'membership_1',
        'pi_456',
        'user_1',
        'FAILED',
      );
    });

    it('does not create duplicate payment if the intent was already recorded', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockReturnValue({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_789',
            amount: 1500,
            currency: 'usd',
            metadata: { organizationId: 'org_1', userId: 'user_1', memberId: 'member_1' },
          },
        },
      });
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue({ id: 'payment_1' });

      await controller.handleWebhook(request(), 'signature');

      expect(paymentsService.createStripePayment).not.toHaveBeenCalled();
    });

    it('returns an error so Stripe can retry when payment persistence fails', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockReturnValue({
        type: 'payment_intent.succeeded',
        data: {
          object: {
            id: 'pi_999',
            amount: 1000,
            currency: 'usd',
            metadata: { organizationId: 'org_1', userId: 'user_1', memberId: 'member_1' },
          },
        },
      });
      (paymentsService.getOneByStripeIntentId as jest.Mock).mockResolvedValue(null);
      (paymentsService.createStripePayment as jest.Mock).mockRejectedValue(
        new Error('Database error'),
      );

      await expect(controller.handleWebhook(request(), 'signature')).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('logs unhandled event types without failing', async () => {
      (configService.get as jest.Mock).mockReturnValue('whsec_123');
      (stripeService.constructEvent as jest.Mock).mockReturnValue({
        type: 'charge.succeeded',
        data: { object: {} },
      });
      const logSpy = jest.spyOn(controller['logger'], 'log');

      await expect(controller.handleWebhook(request(), 'signature')).resolves.toEqual({
        received: true,
      });
      expect(logSpy).toHaveBeenCalledWith('Unhandled event type charge.succeeded');
    });
  });
});
