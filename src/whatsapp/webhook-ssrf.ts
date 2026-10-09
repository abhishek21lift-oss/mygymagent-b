import dns from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import net from 'node:net';

export class WebhookBlockedError extends Error {
  constructor(reason: string) {
    super(`Refusing webhook URL: ${reason}`);
    this.name = 'WebhookBlockedError';
  }
}

// Everything that is not ordinary public unicast: loopback, private,
// link-local, carrier-grade NAT, "this network" (0.0.0.0 connects to the
// local host on Linux), benchmarking, documentation, multicast and
// reserved space, plus the IPv6 forms that embed an IPv4 address.
function blockList(): net.BlockList {
  const list = new net.BlockList();
  for (const [net_, prefix] of [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net_, prefix, 'ipv4');
  }
  for (const [net_, prefix] of [
    ['::', 128],
    ['::1', 128],
    ['64:ff9b::', 96],
    ['64:ff9b:1::', 48],
    ['100::', 64],
    ['2001:db8::', 32],
    ['2002::', 16],
    ['fc00::', 7],
    ['fe80::', 10],
    ['ff00::', 8],
  ] as const) {
    list.addSubnet(net_, prefix, 'ipv6');
  }
  return list;
}

const BLOCKED = blockList();

/** True for any address a webhook must not reach. */
export function isBlockedAddress(address: string): boolean {
  let a = address.toLowerCase();
  // IPv4-mapped IPv6 (`::ffff:10.0.0.1`) must not slip past the list.
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  const family = net.isIP(a);
  if (family === 4) return BLOCKED.check(a, 'ipv4');
  if (family === 6) return BLOCKED.check(a, 'ipv6');
  return true;
}

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
  const addresses = records.map((r) => r.address);
  if (addresses.some(isBlockedAddress) && !allowed(url.hostname, addresses)) {
    throw new WebhookBlockedError(
      `hostname "${url.hostname}" resolves to a private address`,
    );
  }
  return url.href;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for the outgoing connection itself. assertPublicUrl checks
 * a name once, but the socket resolves it again; a name with a zero TTL
 * can answer a public address to the first lookup and 169.254.169.254 to
 * the second. Checking here vets the very addresses the socket uses.
 */
export function guardedLookup(
  hostname: string,
  options: { family?: number; all?: boolean },
  callback: LookupCallback,
): void {
  dns
    .lookup(hostname, { family: options.family ?? 0, all: true })
    .then((records) => {
      const addresses = records.map((r) => r.address);
      if (addresses.some(isBlockedAddress) && !allowed(hostname, addresses)) {
        callback(
          new WebhookBlockedError(
            `hostname "${hostname}" resolves to a private address`,
          ),
          '',
        );
        return;
      }
      if (options.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    })
    .catch((error: NodeJS.ErrnoException) => callback(error, ''));
}
