import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';

export interface RazorpayOrderInput {
  /** Amount in the smallest currency unit (paise for INR, cents for USD). */
  amount: number;
  currency: string;
  /** Merchant reference, e.g. the invoice number (max 40 chars). */
  receipt: string;
  notes?: Record<string, string>;
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status?: string;
}

/**
 * Razorpay online collection over plain HTTPS -- Razorpay's Orders API is
 * a simple basic-auth POST, so no SDK dependency is needed (one less
 * supply-chain surface for payment-adjacent code). Mirrors StripeService's
 * check-at-call-time pattern: missing keys never fail app boot, they fail
 * the individual collection call with a clear 503 instead.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);

  constructor(private readonly config: ConfigService) {
    if (!this.isConfigured()) {
      this.logger.warn(
        'Razorpay keys not configured - online collection features disabled',
      );
    }
  }

  isConfigured(): boolean {
    return Boolean(
      this.config.get<string>('RAZORPAY_KEY_ID') &&
      this.config.get<string>('RAZORPAY_KEY_SECRET'),
    );
  }

  /** The publishable key id -- safe to return to the frontend for
   * Razorpay Checkout. Never the secret. */
  getKeyId(): string | undefined {
    return this.config.get<string>('RAZORPAY_KEY_ID') || undefined;
  }

  ensureConfigured(): void {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'Razorpay is not configured. Set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET to enable online collection.',
      );
    }
  }

  async createOrder(input: RazorpayOrderInput): Promise<RazorpayOrder> {
    this.ensureConfigured();
    const keyId = this.config.get<string>('RAZORPAY_KEY_ID') as string;
    const keySecret = this.config.get<string>('RAZORPAY_KEY_SECRET') as string;
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    let response: Response;
    try {
      response = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amount: input.amount,
          currency: input.currency,
          receipt: input.receipt,
          notes: input.notes,
        }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Razorpay order creation failed: ${message}`);
      throw new InternalServerErrorException(
        'Failed to reach Razorpay while creating the collection order',
      );
    }

    const payload = (await response.json().catch(() => null)) as {
      error?: { description?: string };
      id?: string;
      amount?: number;
      currency?: string;
      receipt?: string;
      status?: string;
    } | null;
    if (!response.ok || !payload?.id) {
      const detail = payload?.error?.description ?? `HTTP ${response.status}`;
      this.logger.error(`Razorpay order creation rejected: ${detail}`);
      throw new InternalServerErrorException(
        `Razorpay rejected the order: ${detail}`,
      );
    }
    return {
      id: payload.id,
      amount: payload.amount as number,
      currency: payload.currency as string,
      receipt: payload.receipt,
      status: payload.status,
    };
  }

  /** True when webhook deliveries can actually be verified. */
  isWebhookConfigured(): boolean {
    return Boolean(this.config.get<string>('RAZORPAY_WEBHOOK_SECRET'));
  }

  /**
   * Verifies a webhook delivery's `x-razorpay-signature` header, which is
   * HMAC-SHA256 over the *raw* request body with RAZORPAY_WEBHOOK_SECRET.
   * Returns false (rather than throwing) when verification is impossible
   * -- no secret configured, no signature header -- so the controller can
   * map each case to the right status code.
   */
  verifyWebhookSignature(
    rawBody: Buffer | string | undefined,
    signature: string | undefined,
  ): boolean {
    const secret = this.config.get<string>('RAZORPAY_WEBHOOK_SECRET');
    if (!secret || !rawBody || !signature) return false;
    const expected = createHmac('sha256', secret).update(rawBody).digest();
    let actual: Buffer;
    try {
      actual = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    return (
      actual.length === expected.length && timingSafeEqual(actual, expected)
    );
  }
}
