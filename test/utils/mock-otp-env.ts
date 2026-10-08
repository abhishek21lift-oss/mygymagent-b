/**
 * Test-only OTP provider selection, for the mock OTP e2e suite.
 *
 * Imported for its side effect, and it must stay the FIRST import in
 * any spec that needs it — module-scope assignment is the only ordering
 * that beats ConfigModule's import-time environment snapshot (see below).
 *
 * `ConfigModule.forRoot({ validate: validateEnv })` is evaluated when
 * `AppModule` is *imported* and the validated result is cached, and
 * `ConfigService.get` prefers that cache over live `process.env` — it
 * only falls through when a key is *absent*, and an empty string is not
 * absent. Setting these in `beforeAll` would lose the race with the
 * import, and the app would silently come up on the MSG91 provider
 * instead: unconfigured, so every `/auth/otp/request` would 400 and the
 * suite would be testing nothing.
 *
 * Module-scope assignment reached by being imported first is the only
 * ordering that wins, because TypeScript emits the imports as `require`
 * calls in source order. Deliberately not `setupFilesAfterEnv`, which
 * would switch the provider for every suite in the run — including the
 * real MSG91 suite, which must keep running against a stubbed carrier.
 */
export const MOCK_OTP_CODE = '123456';
export const MOCK_OTP_TTL_SECONDS = 300;

const previous: Record<string, string | undefined> = {
  OTP_PROVIDER: process.env.OTP_PROVIDER,
  MOCK_OTP: process.env.MOCK_OTP,
  OTP_EXPIRY_SECONDS: process.env.OTP_EXPIRY_SECONDS,
};

process.env.OTP_PROVIDER = 'mock';
process.env.MOCK_OTP = MOCK_OTP_CODE;
process.env.OTP_EXPIRY_SECONDS = String(MOCK_OTP_TTL_SECONDS);

/**
 * Put the machine's own values back. Call from `afterAll`.
 *
 * Defence in depth, not a fix for an observed bug: this was checked, and
 * Jest currently gives each spec file its own `process.env`, so a suite
 * running after this one does see `OTP_PROVIDER` unset and does bind
 * `Msg91OtpDelivery`. (Confirmed by probing a second spec file in the
 * same `--runInBand` run.)
 *
 * It is kept because the property being relied on is the runner's, not
 * ours. The day that isolation changes — a different runner, a future
 * `--runInBand` rework, a suite that boots the app outside a test file —
 * the mock suite would still pass and `member-sms-otp.e2e-spec.ts` would
 * stop exercising MSG91. Restoring is one line and makes the hazard
 * impossible rather than merely absent today.
 */
export function restoreOtpEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
