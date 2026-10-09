import { randomBytes } from 'crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ServiceUnavailableException } from '@nestjs/common';
import { UnrecoverableError } from 'bullmq';
import { JOB_NAMES } from '../queue/queue.constants';
import {
  decryptMfaSecret,
  parseMfaVaultKey,
} from '../auth/mfa/mfa-secret.vault';
import { signWebhook } from './webhook-sign';
import { WebhookDeliveryProcessor } from './webhook-delivery.processor';
import {
  WebhookSecretUnreadableError,
  deriveWebhookSecretKey,
  isWebhookSecretEnvelope,
  openWebhookSecret,
  resolveSigningSecret,
  sealWebhookSecret,
} from './webhook-secret.vault';

process.env.WEBHOOK_ALLOW_PRIVATE_URLS = '127.0.0.1';

const keyHex = randomBytes(32).toString('hex');
const plaintext = randomBytes(32).toString('hex');

/** Flip one hex digit of the envelope's ciphertext segment. */
function tamper(envelope: string): string {
  const parts = envelope.split('.');
  const c = parts[3];
  parts[3] = (c[0] === '0' ? '1' : '0') + c.slice(1);
  return parts.join('.');
}

describe('webhook-secret.vault', () => {
  it('round-trips through a v1 AES-GCM envelope that hides the secret', () => {
    const stored = sealWebhookSecret(plaintext, deriveWebhookSecretKey(keyHex));
    expect(stored).toMatch(/^v1\.[0-9a-f]{24}\.[0-9a-f]{32}\.[0-9a-f]+$/);
    expect(stored).not.toContain(plaintext);
    expect(isWebhookSecretEnvelope(stored)).toBe(true);
    expect(openWebhookSecret(stored, keyHex)).toBe(plaintext);
  });

  it('uses a subkey: the raw MFA key cannot open a webhook envelope', () => {
    const stored = sealWebhookSecret(plaintext, deriveWebhookSecretKey(keyHex));
    expect(() => decryptMfaSecret(stored, parseMfaVaultKey(keyHex))).toThrow();
  });

  it('passes legacy plaintext through unchanged, with or without a key', () => {
    expect(isWebhookSecretEnvelope(plaintext)).toBe(false);
    expect(openWebhookSecret(plaintext, keyHex)).toBe(plaintext);
    expect(openWebhookSecret(plaintext, undefined)).toBe(plaintext);
  });

  it('fails closed on a tampered or truncated envelope', () => {
    const stored = sealWebhookSecret(plaintext, deriveWebhookSecretKey(keyHex));
    expect(() => openWebhookSecret(tamper(stored), keyHex)).toThrow(
      WebhookSecretUnreadableError,
    );
    expect(() => openWebhookSecret('v1.abc', keyHex)).toThrow(
      WebhookSecretUnreadableError,
    );
    expect(() =>
      openWebhookSecret(stored, randomBytes(32).toString('hex')),
    ).toThrow(WebhookSecretUnreadableError);
  });

  it('answers 503 (like the MFA vault) when the key is missing', () => {
    expect(() => deriveWebhookSecretKey(undefined)).toThrow(
      ServiceUnavailableException,
    );
    expect(() => deriveWebhookSecretKey('nothex')).toThrow(
      ServiceUnavailableException,
    );
    const stored = sealWebhookSecret(plaintext, deriveWebhookSecretKey(keyHex));
    expect(() => openWebhookSecret(stored, undefined)).toThrow(
      ServiceUnavailableException,
    );
  });

  describe('resolveSigningSecret lazy re-encryption', () => {
    function prisma() {
      return {
        webhookSubscription: {
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
      };
    }

    it('re-encrypts a legacy row with compare-and-set on the old value', async () => {
      const db = prisma();
      const out = await resolveSigningSecret(
        db as never,
        { id: 's1', secret: plaintext },
        keyHex,
      );
      expect(out).toBe(plaintext);
      expect(db.webhookSubscription.updateMany).toHaveBeenCalledTimes(1);
      const call = (
        db.webhookSubscription.updateMany.mock.calls[0] as unknown as [
          { where: unknown; data: { secret: string } },
        ]
      )[0];
      expect(call.where).toEqual({ id: 's1', secret: plaintext });
      expect(openWebhookSecret(call.data.secret, keyHex)).toBe(plaintext);
    });

    it('leaves legacy rows alone when no key is configured', async () => {
      const db = prisma();
      await expect(
        resolveSigningSecret(db as never, { id: 's1', secret: plaintext }, ''),
      ).resolves.toBe(plaintext);
      expect(db.webhookSubscription.updateMany).not.toHaveBeenCalled();
    });

    it('still signs when the opportunistic rewrite fails', async () => {
      const db = prisma();
      db.webhookSubscription.updateMany.mockRejectedValueOnce(
        new Error('db down'),
      );
      await expect(
        resolveSigningSecret(
          db as never,
          { id: 's1', secret: plaintext },
          keyHex,
        ),
      ).resolves.toBe(plaintext);
    });

    it('never rewrites an envelope row', async () => {
      const db = prisma();
      const stored = sealWebhookSecret(
        plaintext,
        deriveWebhookSecretKey(keyHex),
      );
      await expect(
        resolveSigningSecret(db as never, { id: 's1', secret: stored }, keyHex),
      ).resolves.toBe(plaintext);
      expect(db.webhookSubscription.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe('WebhookDeliveryProcessor signing with stored secrets', () => {
  let server: http.Server;
  let base: string;
  const hits: { signature: string; raw: string }[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        hits.push({
          signature: String(req.headers['x-webhook-signature']),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        res.writeHead(200).end('ok');
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits.length = 0;
  });

  function run(secret: string, env: Record<string, string | undefined>) {
    const prisma = {
      webhookSubscription: {
        findFirst: jest.fn(async () => ({
          id: 's1',
          organizationId: 'o1',
          url: `${base}/hook`,
          secret,
          enabled: true,
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      webhookDelivery: { update: jest.fn(async () => undefined) },
    };
    const config = { get: (name: string) => env[name] };
    const svc = new WebhookDeliveryProcessor(prisma as never, config as never);
    const job = {
      name: JOB_NAMES.DELIVER_WEBHOOK,
      data: {
        subscriptionId: 's1',
        deliveryId: 'd1',
        organizationId: 'o1',
        event: 'message.received',
        data: { from: '9198' },
      },
      attemptsMade: 0,
      opts: { attempts: 3 },
    } as never;
    return { svc, prisma, job };
  }

  it('signs a legacy plaintext row exactly as before (no key needed)', async () => {
    const { svc, job } = run(plaintext, {});
    await svc.process(job);
    expect(hits).toHaveLength(1);
    expect(hits[0].signature).toBe(
      `sha256=${signWebhook(plaintext, hits[0].raw)}`,
    );
  });

  it('signs a legacy row identically when a key is set, and re-encrypts it', async () => {
    const { svc, job, prisma } = run(plaintext, { MFA_TOTP_KEY: keyHex });
    await svc.process(job);
    expect(hits[0].signature).toBe(
      `sha256=${signWebhook(plaintext, hits[0].raw)}`,
    );
    expect(prisma.webhookSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', secret: plaintext },
      data: { secret: expect.stringMatching(/^v1\./) },
    });
  });

  it('signs an envelope row with the decrypted secret', async () => {
    const stored = sealWebhookSecret(plaintext, deriveWebhookSecretKey(keyHex));
    const { svc, job } = run(stored, { MFA_TOTP_KEY: keyHex });
    await svc.process(job);
    expect(hits[0].signature).toBe(
      `sha256=${signWebhook(plaintext, hits[0].raw)}`,
    );
  });

  it.each([
    ['tampered', { MFA_TOTP_KEY: keyHex }, true],
    ['key missing', {}, false],
    ['wrong key', { MFA_TOTP_KEY: randomBytes(32).toString('hex') }, false],
  ])(
    'fails closed (%s): delivery FAILED, nothing POSTed',
    async (_label, env, doTamper) => {
      const sealed = sealWebhookSecret(
        plaintext,
        deriveWebhookSecretKey(keyHex),
      );
      const { svc, job, prisma } = run(doTamper ? tamper(sealed) : sealed, env);
      await expect(svc.process(job)).rejects.toThrow(UnrecoverableError);
      expect(hits).toHaveLength(0);
      expect(prisma.webhookDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: expect.objectContaining({ status: 'FAILED' }),
      });
      expect(prisma.webhookSubscription.updateMany).not.toHaveBeenCalled();
    },
  );
});
