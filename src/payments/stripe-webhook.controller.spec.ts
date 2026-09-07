import { Test } from '@nestjs/testing';
import type { Request } from 'express';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { StripeWebhookController } from './stripe-webhook.controller';
import { StripeService } from './stripe.service';
import { PaymentsService } from '../billing/payments.service';

/** Builds the express request shape the controller reads: rawBody bytes
 * plus a parsed body mirror (supertest/Nest both populate these when
 * rawBody parsing is on). */
function webhookRequest(parsedBody: unknown): Request & {
  rawBody?: Buffer;
} {
  return {
    body: parsedBody,
    rawBody: Buffer.from(JSON.stringify(parsedBody)),
  } as unknown as Request & { rawBody?: Buffer };
}

function emptyRequest(): Request & { rawBody?: Buffer } {
  return { body: {} } as unknown as Request & { rawBody?: Buffer };
}

describe('StripeWebhookController', () => {
  let controller: StripeWebhookController;
  let stripeService: { constructEvent: jest.Mock };
  let paymentsService: { createStripePayment: jest.Mock };
  let configService: { get: jest.Mock };

  beforeEach(async () => {
    stripeService = { constructEvent: jest.fn() };
    paymentsService = { createStripePayment: jest.fn() };
    configService = { get: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      controllers: [StripeWebhookController],
      providers: [
        { provide: StripeService, useValue: stripeService },
        { provide: PaymentsService, useValue: paymentsService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    controller = moduleRef.get(StripeWebhookController);
  });

  it('throws when the webhook secret is not configured', async () => {
    configService.get.mockReturnValue(null);
    await expect(
      controller.handleWebhook(webhookRequest({}), 'signature'),
    ).rejects.toBeInstanceOf(Error);
  });

  it('throws BadRequest when the raw body is missing', async () => {
    configService.get.mockReturnValue('whsec_123');
    await expect(
      controller.handleWebhook(emptyRequest(), 'sig'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws BadRequest when the signature header is missing', async () => {
    configService.get.mockReturnValue('whsec_123');
    await expect(
      controller.handleWebhook(webhookRequest({}), ''),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('throws Unauthorized when signature verification fails, without echoing internals', async () => {
    configService.get.mockReturnValue('whsec_123');
    stripeService.constructEvent.mockImplementation(() => {
      throw new Error('secret internal detail');
    });

    const error = (await controller
      .handleWebhook(webhookRequest({}), 'signature')
      .catch((e: unknown) => e)) as UnauthorizedException;
    expect(error).toBeInstanceOf(UnauthorizedException);
    expect((error as Error).message).not.toContain('secret internal detail');
  });

  it('records a succeeded intent in major units (cents / 100)', async () => {
    configService.get.mockReturnValue('whsec_123');
    stripeService.constructEvent.mockResolvedValue({
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
    });

    const result = await controller.handleWebhook(
      webhookRequest({ id: 'pi_123' }),
      'signature',
    );
    expect(result).toEqual({ received: true });
    expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
      'org_1',
      10, // 1000 cents -> $10.00, not 1000.00
      'USD',
      'member_1',
      undefined,
      'pi_123',
      'user_1',
      'COMPLETED',
    );
  });

  it('records a failed intent in major units', async () => {
    configService.get.mockReturnValue('whsec_123');
    stripeService.constructEvent.mockResolvedValue({
      type: 'payment_intent.payment_failed',
      data: {
        object: {
          id: 'pi_456',
          amount: 25000,
          currency: 'usd',
          metadata: {
            organizationId: 'org_1',
            userId: 'user_1',
          },
        },
      },
    });

    await controller.handleWebhook(webhookRequest({ id: 'pi_456' }), 'sig');
    expect(paymentsService.createStripePayment).toHaveBeenCalledWith(
      'org_1',
      250, // 25000 cents -> $250.00
      'USD',
      undefined,
      undefined,
      'pi_456',
      'user_1',
      'FAILED',
    );
  });

  it('skips intents without the required metadata (no error thrown)', async () => {
    configService.get.mockReturnValue('whsec_123');
    stripeService.constructEvent.mockResolvedValue({
      type: 'payment_intent.succeeded',
      data: {
        object: { id: 'pi_789', amount: 100, currency: 'usd', metadata: {} },
      },
    });

    await expect(
      controller.handleWebhook(webhookRequest({}), 'sig'),
    ).resolves.toEqual({ received: true });
    expect(paymentsService.createStripePayment).not.toHaveBeenCalled();
  });

  it('lets handler errors propagate so Stripe retries', async () => {
    configService.get.mockReturnValue('whsec_123');
    stripeService.constructEvent.mockResolvedValue({
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: 'pi_000',
          amount: 100,
          currency: 'usd',
          metadata: { organizationId: 'org_1', userId: 'user_1' },
        },
      },
    });
    paymentsService.createStripePayment.mockRejectedValue(
      new Error('transient db failure'),
    );

    // Handler failures are no longer swallowed with a fake success --
    // the 500 makes Stripe retry the delivery.
    await expect(
      controller.handleWebhook(webhookRequest({}), 'sig'),
    ).rejects.toThrow('transient db failure');
  });
});
