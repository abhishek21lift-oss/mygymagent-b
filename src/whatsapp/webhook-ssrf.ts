import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net from 'node:net';

export class WebhookBlockedError extends Error {
  constructor(reason: string) {
    super(`Refusing webhook URL: ${reason}`);
    this.name = 'WebhookBlockedError';
  }
}

function blockList(): net.BlockList {
  const list = new net.BlockList();
  for (const [net_, prefix] of [
    ['127.0.0.0', 8],
    ['10.0.0.0', 8],
    ['172.16.0.0', 12],
    ['192.168.0.0', 16],
    ['169.254.0.0', 16],
  ] as const) {
    list.addSubnet(net_, prefix, 'ipv4');
  }
  list.addAddress('::1', 'ipv6');
  list.addSubnet('fe80::', 10, 'ipv6');
  list.addSubnet('fc00::', 7, 'ipv6');
  return list;
}

const BLOCKED = blockList();

function allowed(name: string, addresses: string[]): boolean {
  const extra = (process.env.WEBHOOK_ALLOW_PRIVATE_URLS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (extra.includes(name.toLowerCase())) return true;
  return addresses.some((a) => extra.includes(a.toLowerCase()));
}

/**
 * SSRF guard for user-supplied webhook URLs: only http/https, every
 * resolved address must be public (or allowlisted for tests via
 * `WEBHOOK_ALLOW_PRIVATE_URLS`). Returns the normalized href.
 */
export async function assertPublicUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new WebhookBlockedError('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebhookBlockedError(`protocol "${url.protocol}" not allowed`);
  }
  let records: LookupAddress[];
  try {
    records = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new WebhookBlockedError(
      `hostname "${url.hostname}" does not resolve`,
    );
  }
  // IPv4-mapped IPv6 (`::ffff:10.0.0.1`) must not slip past the list.
  const addresses = records.map((r) =>
    r.address.toLowerCase().startsWith('::ffff:')
      ? r.address.slice('::ffff:'.length)
      : r.address,
  );
  const blocked = addresses.filter(
    (a) => net.isIP(a) !== 0 && (BLOCKED.check(a) || a === '169.254.169.254'),
  );
  if (blocked.length > 0 && !allowed(url.hostname, addresses)) {
    throw new WebhookBlockedError(
      `hostname "${url.hostname}" resolves to a private address`,
    );
  }
  return url.href;
}
