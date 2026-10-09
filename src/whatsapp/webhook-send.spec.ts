import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { signWebhook } from './webhook-sign';
import {
  WebhookBlockedError,
  WebhookHttpError,
  WebhookNetworkError,
  postWebhook,
} from './webhook-send';

const ALLOW = process.env.WEBHOOK_ALLOW_PRIVATE_URLS;

let server: http.Server;
let base: string;
const seen: { url: string; signature: string | undefined; body: string }[] = [];

beforeAll(async () => {
  process.env.WEBHOOK_ALLOW_PRIVATE_URLS = '127.0.0.1';
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      seen.push({
        url: req.url ?? '/',
        signature: req.headers['x-webhook-signature'] as string | undefined,
        body: raw,
      });
      if (req.url === '/fail') {
        res.writeHead(500).end('boom');
      } else if (req.url === '/r1' || req.url === '/r2' || req.url === '/r3') {
        const next = `/r${Number(req.url.slice(2)) + 1}`;
        res.writeHead(302, { location: next }).end();
      } else {
        res.writeHead(200).end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  if (ALLOW === undefined) delete process.env.WEBHOOK_ALLOW_PRIVATE_URLS;
  else process.env.WEBHOOK_ALLOW_PRIVATE_URLS = ALLOW;
});

beforeEach(() => {
  seen.length = 0;
});

const payload = {
  event: 'message.received',
  organizationId: 'o1',
  timestamp: '2026-10-09T00:00:00.000Z',
  data: { from: '919876543211', body: 'hello' },
};

describe('postWebhook', () => {
  it('POSTs signed JSON the receiver can recompute', async () => {
    const res = await postWebhook(`${base}/hook`, 's3cret', payload);
    expect(res).toEqual({ httpStatus: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0].signature).toBe(
      `sha256=${signWebhook('s3cret', seen[0].body)}`,
    );
    expect(JSON.parse(seen[0].body)).toEqual(payload);
  });

  it('signs unicode secrets and bodies', async () => {
    await postWebhook(`${base}/hook`, 'sëcret', {
      ...payload,
      data: { body: 'नमस्ते 🎉' },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].signature).toBe(
      `sha256=${signWebhook('sëcret', seen[0].body)}`,
    );
  });

  it('throws retryable WebhookHttpError on 500', async () => {
    const err = await postWebhook(`${base}/fail`, 's3cret', payload).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WebhookHttpError);
    expect((err as WebhookHttpError).httpStatus).toBe(500);
  });

  it('throws retryable WebhookNetworkError when refused', async () => {
    await expect(
      postWebhook('http://127.0.0.1:1/hook', 's3cret', payload),
    ).rejects.toThrow(WebhookNetworkError);
  });

  it('stops after 2 redirect follows', async () => {
    await expect(postWebhook(`${base}/r1`, 's3cret', payload)).rejects.toThrow(
      WebhookBlockedError,
    );
    expect(seen.map((s) => s.url)).toEqual(['/r1', '/r2', '/r3']);
  });

  it('never attempts private URLs', async () => {
    await expect(
      postWebhook('http://192.168.1.5/hook', 's3cret', payload),
    ).rejects.toThrow(WebhookBlockedError);
    expect(seen).toHaveLength(0);
  });
});
