import { Injectable } from '@nestjs/common';
import { randomInt } from 'crypto';
import { Msg91SmsProvider } from '../../communications/providers/msg91-sms.provider';
import type { OtpDelivery } from './otp-delivery.interface';

/** Six digits, zero-padded. Unchanged: a member reading a code off a
 *  handset should not have to guess whether a leading zero is missing. */
const CODE_DIGITS = 6;

/**
 * The real provider: a CSPRNG code generated here, carried by MSG91.
 *
 * This is the whole production path, and it is deliberately the same
 * shape it was before `OTP_PROVIDER` existed — same RNG, same hashing in
 * `MemberOtpService`, same `Msg91SmsProvider` call, same refusal when
 * MSG91 is unconfigured. The only thing that moved is *where* the code
 * is generated, from the service to the object that delivers it, so that
 * the mock provider can own its own fixed code without the service
 * needing to know which one it is holding.
 */
@Injectable()
export class Msg91OtpDelivery implements OtpDelivery {
  readonly providerName = 'msg91' as const;

  constructor(private readonly sms: Msg91SmsProvider) {}

  isConfigured(): boolean {
    return this.sms.isConfigured();
  }

  /**
   * `randomInt` is the CSPRNG; `Math.random` would make each code
   * guessable from the one before it, which is the whole of a six-digit
   * code's entropy.
   */
  issueCode(): string {
    return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
  }

  async send(args: {
    to: string;
    code: string;
    organizationId: string;
  }): Promise<void> {
    await this.sms.send({
      to: args.to,
      text: args.code,
      organizationId: args.organizationId,
    });
  }
}
