import { existsSync, readFileSync } from 'fs';

interface CapturedEmail {
  from: string | null;
  to: string[];
  raw: string;
  receivedAt: string;
}

/** Undoes RFC 2045 quoted-printable encoding: soft line-wraps (a trailing
 * `=` before the CRLF is a no-op join, not a real line break -- applied
 * to any plain-text body over ~76 chars per line, which a long
 * reset-link URL/token routinely is) and `=XX` hex-escapes (QP's escape
 * character is itself `=`, so a literal `=` in the source text --
 * `?token=<value>` in every link this app sends -- comes back as `=3D`).
 * Every real mail client reverses both before a human ever sees the
 * text; this test double has to do the same to read what was sent. */
function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
      String.fromCharCode(parseInt(hex, 16)),
    );
}

/** Parses out the handful of headers/body tests actually assert on --
 * not a general MIME parser, matching SmtpEmailProvider's plain-text-only
 * sendMail() (no HTML, no attachments) so there's nothing more to parse. */
function parseRaw(raw: string): { subject: string; body: string } {
  const headerEnd = raw.indexOf('\r\n\r\n');
  const header = headerEnd >= 0 ? raw.slice(0, headerEnd) : raw;
  let body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
  const subjectMatch = /^Subject: (.*)$/im.exec(header);
  if (/^Content-Transfer-Encoding: quoted-printable$/im.test(header)) {
    body = decodeQuotedPrintable(body);
  }
  return { subject: subjectMatch?.[1]?.trim() ?? '', body };
}

function readAll(captureFile: string): CapturedEmail[] {
  if (!existsSync(captureFile)) return [];
  return readFileSync(captureFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CapturedEmail);
}

/** Polls the capture file (written by smtp-capture-server.ts, a real
 * local SMTP server the app's SmtpEmailProvider actually sends to) for
 * the most recent message to `recipient`, up to `timeoutMs`. Throws on
 * timeout rather than returning undefined -- a missing email is a test
 * failure, not a value for the caller to null-check. */
export async function waitForEmailTo(
  recipient: string,
  timeoutMs = 5000,
): Promise<{ subject: string; body: string; raw: string }> {
  const captureFile = process.env.SMTP_TEST_CAPTURE_FILE;
  if (!captureFile) throw new Error('SMTP_TEST_CAPTURE_FILE must be set');

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const match = readAll(captureFile)
      .reverse()
      .find((email) => email.to.includes(recipient));
    if (match) return { ...parseRaw(match.raw), raw: match.raw };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for an email to ${recipient}`);
}
