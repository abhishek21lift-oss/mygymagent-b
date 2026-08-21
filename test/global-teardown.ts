import type { SMTPServer } from 'smtp-server';

/** Closes the SMTP capture server global-setup.ts started in this same
 * long-lived Jest orchestrator process. */
export default async function globalTeardown(): Promise<void> {
  const server = (
    globalThis as typeof globalThis & { __SMTP_CAPTURE_SERVER__?: SMTPServer }
  ).__SMTP_CAPTURE_SERVER__;
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
