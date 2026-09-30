/**
 * Turns WhatsApp Web on for one suite, with no spacing between sends.
 *
 * Imported for its side effect and must be the FIRST import in the spec,
 * for the reason given in whatsapp-test-env.ts: ConfigModule snapshots the
 * environment when AppModule is imported.
 */
const KEYS = [
  'WHATSAPP_WEB_ENABLED',
  'WHATSAPP_WEB_MIN_GAP_MS',
  'WHATSAPP_WEB_JITTER_MS',
  'WHATSAPP_TOKEN_KEY',
  'WHATSAPP_WEB_PAIRING_TIMEOUT_MS',
] as const;
const previous = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

process.env.WHATSAPP_WEB_ENABLED = 'true';
process.env.WHATSAPP_WEB_MIN_GAP_MS = '0';
process.env.WHATSAPP_WEB_JITTER_MS = '0';
// Short, so the "WhatsApp never answered" case is testable.
process.env.WHATSAPP_WEB_PAIRING_TIMEOUT_MS = '3000';
process.env.WHATSAPP_TOKEN_KEY ||= 'a'.repeat(64);

export function restoreWhatsappWebTestEnv(): void {
  for (const key of KEYS) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
}
