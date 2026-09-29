import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { OtpDelivery } from './otp-delivery.interface';

/** The code used when `MOCK_OTP` is unset. Fixed, so a developer who
 *  never reads the log still knows what to type. */
export const DEFAULT_MOCK_OTP = '123456';

/**
 * A fixed code that nobody is sent, for development and test only.
 *
 * It exists because the alternative is worse: without it, exercising the
 * member OTP flow locally means buying an MSG91 account, registering a
 * DLT template against a real sender id, and reading the code off a real
 * handset. People then skip the flow, and a login path with no
 * local exercise is a login path nobody notices is broken until
 * production.
 *
 * Three independent things stop it from working in production, because
 * one is not enough:
 *
 * 1. `env.validation.ts` refuses to *boot* with `OTP_PROVIDER=mock` or a
 *    set `MOCK_OTP` when `NODE_ENV=production`. This is the layer that
 *    actually holds — the process does not come up at all.
 * 2. This class throws from its constructor in production, so even a
 *    caller that constructs it directly (a test, a script) cannot get a
 *    working instance.
 * 3. `isConfigured()` reports false in production regardless, so a
 *    binding that somehow existed would refuse the login flow up front
 *    rather than issue a guessable code.
 *
 * The code is written to the log in development so a developer does not
 * have to keep the fixed value in their head, and never in production —
 * both because of the throw above and because the log line that carries
 * it is gated on the same check.
 *
 * It is hashed, expiring and attempt-counted exactly like a real code:
 * the point is to exercise the real flow, not a shortcut around it. A
 * mock that skipped expiry or the five-attempt limit would be testing
 * something the deployed system does not do.
 */
@Injectable()
export class MockOtpDelivery implements OtpDelivery {
  readonly providerName = 'mock' as const;

  private readonly logger = new Logger(MockOtpDelivery.name);

  constructor(private readonly config: ConfigService) {
    if (this.isProduction) {
      throw new Error(
        'MockOtpDelivery is development/test only. Production must use OTP_PROVIDER=msg91, which env.validation.ts enforces at boot.',
      );
    }
  }

  private get isProduction(): boolean {
    return this.config.get<string>('NODE_ENV') === 'production';
  }

  /**
   * Always true off production. The mock needs no carrier, no template
   * and no credentials, so the one reason `Msg91OtpDelivery` reports
   * false — nothing configured to deliver with — does not apply. In
   * production this is false, which makes `MemberOtpService` refuse the
   * flow before issuing anything.
   */
  isConfigured(): boolean {
    return !this.isProduction;
  }

  issueCode(): string {
    if (this.isProduction) {
      // Unreachable through DI (the constructor already threw) and
      // through the binding (isConfigured() is false). Kept because a
      // security control that only exists on the path you remember to
      // take is not a control.
      throw new Error('MockOtpDelivery cannot issue a code in production');
    }
    return this.config.get<string>('MOCK_OTP') || DEFAULT_MOCK_OTP;
  }

  async send(args: {
    to: string;
    code: string;
    organizationId: string;
  }): Promise<void> {
    if (this.isProduction) {
      throw new Error('MockOtpDelivery cannot deliver a code in production');
    }

    // The code, because a developer should not have to read
    // `.env.example` to find it. The recipient is not logged: it
    // identifies the person logging in, exactly as the MSG91 provider
    // declines to log it.
    this.logger.warn(
      `Mock OTP: no SMS sent. The code for +${args.to.replace(/\D/g, '').slice(-10)} is ${args.code}`,
    );
  }
}
