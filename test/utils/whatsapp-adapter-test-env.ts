/**
 * Test-only feature flag for the WhatsApp adapter read surfaces.
 *
 * MUST stay the first import in this file: ConfigModule snapshots the
 * environment when AppModule is imported, so setting this in `beforeAll`
 * loses the race and the adapter guard silently reports DISABLED.
 * Restored in `afterAll` so later suites keep the default fail-closed
 * behavior.
 */
const FLAG = 'WHATSAPP_ADAPTER_ENABLED';
const previousFlag = process.env[FLAG];
process.env[FLAG] ||= 'true';

export function restoreAdapterFlag(): void {
  if (previousFlag === undefined) delete process.env[FLAG];
  else process.env[FLAG] = previousFlag;
}
