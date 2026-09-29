/**
 * Test-only Meta credentials for the WhatsApp webhook suite.
 *
 * Imported for its side effect, and it must stay the FIRST import in
 * any spec that needs these — see the note below.
 *
 * `ConfigModule.forRoot({ validate: validateEnv })` is evaluated when
 * `AppModule` is *imported*, and the validated result is cached. When a
 * developer has a local `.env` (untracked, so it exists on workstations
 * and not in CI) it supplies `META_APP_SECRET=""` and
 * `META_WABA_VERIFY_TOKEN=""`, and that empty snapshot is what
 * `ConfigService.get()` returns — the live `process.env` is only consulted
 * when the key is *absent* from the snapshot, and an empty string is not
 * absent. Setting the variables in `beforeAll` therefore loses the race
 * with the import and the HMAC check silently degrades to the documented
 * development bypass, which makes the signature assertions vacuous.
 *
 * The suite asserted 200 where it expected 403 locally and passed in CI,
 * which is the worst possible shape: a security test that fails on a
 * developer machine and passes on the build.
 *
 * Module-scope assignment, reached by being imported first, is the only
 * ordering that wins: TypeScript compiles these imports to `require`
 * calls in source order, so this runs before `test-app` pulls in
 * `AppModule`. Deliberately not `setupFilesAfterEnv`, which would apply
 * these credentials to every suite in the run.
 */
export const META_TEST_APP_SECRET = 'test-meta-app-secret';
export const META_TEST_VERIFY_TOKEN = 'test-meta-verify-token';

const previous: Record<string, string | undefined> = {
  META_APP_SECRET: process.env.META_APP_SECRET,
  META_WABA_VERIFY_TOKEN: process.env.META_WABA_VERIFY_TOKEN,
};

process.env.META_APP_SECRET = META_TEST_APP_SECRET;
process.env.META_WABA_VERIFY_TOKEN = META_TEST_VERIFY_TOKEN;

/** Put the machine's own values back. Call from `afterAll` so a suite
 * does not leave a fake app secret in the environment for whatever runs
 * next in the same worker. */
export function restoreWhatsAppTestEnv(): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
