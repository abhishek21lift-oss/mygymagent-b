/**
 * Test-only session vault key for the WhatsApp session suites.
 *
 * Imported for its side effect, and it must stay the FIRST import in
 * any spec that needs it: ConfigModule snapshots the environment when
 * AppModule is imported, so setting this in `beforeAll` loses the race
 * and availability checks silently report DISABLED.
 */
const KEYS = ['WA_AUTH_KEY'] as const;
const previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

process.env.WA_AUTH_KEY ||= 'b'.repeat(64);

export function restoreWaAuthTestEnv(): void {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
