/**
 * How a member login code is produced and delivered.
 *
 * Two implementations: `msg91` (the real one — a CSPRNG code generated
 * here, hashed here, carried by SMS through a DLT-registered template)
 * and `mock` (development and test only — a fixed code, nothing sent).
 * Which one is bound is decided by `OTP_PROVIDER`; see `auth.module.ts`.
 *
 * `issueCode()` lives on the provider rather than in `MemberOtpService`
 * because generation and delivery are one decision: a provider that
 * could deliver a code it did not produce would be one where the two
 * halves can drift, and the MSG91 OTP endpoint exists precisely to be
 * declined. See `Msg91OtpDelivery.issueCode()` for why MSG91's own
 * generator is not used even though the account pays for it.
 *
 * `MemberOtpService` never inspects which implementation it holds. That
 * is the point of the interface: the "never in production" rule is
 * enforced once, in `MockOtpDelivery` and in the env schema, rather than
 * being a branch in the service that a future edit could take the wrong
 * side of.
 */
export interface OtpDelivery {
  /** Stable name for logs and tests. Never the code itself. */
  readonly providerName: 'msg91' | 'mock';

  /**
   * Whether a code could actually reach a member right now. Callers use
   * this to refuse a login up front rather than issue a code that cannot
   * be delivered.
   */
  isConfigured(): boolean;

  /**
   * A fresh code for one challenge. Six digits, zero-padded. The caller
   * hashes it immediately and must not log it.
   */
  issueCode(): string;

  /**
   * Carry `code` to `to`. Throws on failure -- a code that was never
   * delivered must not look like one that was.
   */
  send(args: {
    to: string;
    code: string;
    organizationId: string;
  }): Promise<void>;
}

/**
 * DI token. A symbol rather than a class because the implementation is
 * chosen at wiring time and a class token would name one of them.
 */
export const OTP_DELIVERY = Symbol('OTP_DELIVERY');
