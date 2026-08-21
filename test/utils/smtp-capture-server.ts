import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { SMTPServer } from 'smtp-server';

/**
 * Stands in for a real mail relay in the e2e suite -- same "real
 * infrastructure, not a mock" discipline as s3rver for object storage.
 * SmtpEmailProvider (src/communications/providers/) speaks real SMTP to
 * it via nodemailer; every accepted message is appended as one JSON line
 * to `captureFile` for test/utils/mailbox.ts to poll and assert against.
 *
 * Started in-process by test/global-setup.ts (Jest's orchestrator process
 * stays alive for the whole run, so a plain TCP server started there is
 * reachable from every test-file worker process too -- no subprocess/pid
 * bookkeeping needed) and stopped by test/global-teardown.ts.
 *
 * No AUTH/TLS -- matches SMTP_SECURE=false and no SMTP_USER in .env.test.
 */
export function startSmtpCaptureServer(
  port: number,
  captureFile: string,
): Promise<SMTPServer> {
  mkdirSync(dirname(captureFile), { recursive: true });

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['AUTH', 'STARTTLS'],
    logger: false,
    onData(stream, session, callback) {
      // A stream error (or any exception while handling 'end') must still
      // resolve `callback` -- SMTP is request/response, so a client that
      // never gets a reply (nodemailer's sendMail here) hangs forever
      // waiting for one, which then hangs a BullMQ job processing it,
      // which then hangs that queue's graceful shutdown on app.close().
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        callback(err);
      };
      const chunks: Buffer[] = [];
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('error', finish);
      stream.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          const entry = {
            from: session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : null,
            to: session.envelope.rcptTo.map((r) => r.address),
            raw,
            receivedAt: new Date().toISOString(),
          };
          appendFileSync(captureFile, JSON.stringify(entry) + '\n');
          finish();
        } catch (error) {
          finish(error as Error);
        }
      });
    },
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, () => resolve(server));
  });
}
