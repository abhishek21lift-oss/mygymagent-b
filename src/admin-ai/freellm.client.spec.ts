import type { ConfigService } from '@nestjs/config';
import { FreellmClient } from './freellm.client';

function clientWith(env: Record<string, string | undefined>) {
  return new FreellmClient({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

describe('FreellmClient.usesLoopbackBaseUrl', () => {
  it('flags the localhost default a hosted deploy was never configured past', () => {
    expect(clientWith({}).usesLoopbackBaseUrl()).toBe(true);
    expect(
      clientWith({
        FREELLM_BASE_URL: 'http://localhost:3001/',
      }).usesLoopbackBaseUrl(),
    ).toBe(true);
  });

  it('accepts a real service URL', () => {
    expect(
      clientWith({
        FREELLM_BASE_URL: 'https://freellm.internal.example.com',
      }).usesLoopbackBaseUrl(),
    ).toBe(false);
  });
});

import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';

/**
 * The login/session contract the Command Center diagnosis depends on:
 * missing creds, wrong creds, expired sessions, timeouts and unreachable
 * hosts must each surface as their own actionable error -- never as each
 * other, and never with secret content.
 */
describe('FreellmClient session and failure mapping', () => {
  const ENV = {
    FREELLM_BASE_URL: 'http://freellmapi:3001',
    FREELLM_EMAIL: 'ops@example.com',
    FREELLM_PASSWORD: 'correct-horse',
  };

  const json = (status: number, body: unknown) =>
    ({
      status,
      ok: status >= 200 && status < 300,
      text: async () => (body === undefined ? '' : JSON.stringify(body)),
    }) as Response;

  const loginOk = (token = 'tok-1') => json(200, { token });

  let fetchMock: jest.SpyInstance;
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch');
  });
  afterEach(() => {
    fetchMock.mockRestore();
  });

  const loginCalls = () =>
    fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith('/api/auth/login'),
    );

  it('rejects wrong dashboard credentials distinctly, without echoing the address', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'bad login' }));
    const client = clientWith(ENV);

    const err = await client.get('/api/keys/providers').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as BadGatewayException).getStatus()).toBe(502);
    expect((err as Error).message).toBe(
      'FreeLLMAPI rejected the dashboard credentials',
    );
    expect((err as Error).message).not.toContain('ops@example.com');
  });

  it('logs in once and reuses the session across calls', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(json(200, { a: 1 }))
      .mockResolvedValueOnce(json(200, { b: 2 }));
    const client = clientWith(ENV);

    await client.get('/api/keys/providers');
    await client.get('/api/models');

    expect(loginCalls()).toHaveLength(1);
    const authed = fetchMock.mock.calls.filter(([, init]) =>
      (init as RequestInit)?.headers
        ? JSON.stringify((init as RequestInit).headers).includes('tok-1')
        : false,
    );
    expect(authed).toHaveLength(2);
  });

  it('shares one in-flight login between concurrent calls', async () => {
    let resolveLogin!: (r: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveLogin = resolve)),
    );
    fetchMock.mockResolvedValue(json(200, { ok: true }));
    const client = clientWith(ENV);

    const both = Promise.all([
      client.get('/api/keys/providers'),
      client.get('/api/models'),
    ]);
    // Let both calls attach to the in-flight login, then answer it once.
    await new Promise((r) => setTimeout(r, 10));
    resolveLogin(loginOk());
    const [a, b] = await both;
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(loginCalls()).toHaveLength(1);
  });

  it('re-authenticates exactly once on an expired session, then succeeds', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('tok-1'))
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(loginOk('tok-2'))
      .mockResolvedValueOnce(json(200, { models: [] }));
    const client = clientWith(ENV);

    await expect(client.get('/api/models')).resolves.toEqual({ models: [] });
    expect(loginCalls()).toHaveLength(2);
  });

  it('stops after the retry when re-authentication also fails (no login loop)', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk('tok-1'))
      .mockResolvedValueOnce(json(401, {}))
      .mockResolvedValueOnce(loginOk('tok-2'))
      .mockResolvedValueOnce(json(401, {}));
    const client = clientWith(ENV);

    await expect(client.get('/api/models')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    expect(loginCalls()).toHaveLength(2);
  });

  it('maps an aborted request to 503 timeout', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    fetchMock.mockRejectedValueOnce(abort);
    const client = clientWith(ENV);

    const err = await client.getPublic('/livez').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it('maps unreachable hosts to 502 without upstream detail', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    const client = clientWith(ENV);

    const err = await client.getPublic('/livez').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as Error).message).toBe('FreeLLMAPI is unreachable');
  });

  it('maps upstream 500s generically and never echoes the body', async () => {
    fetchMock
      .mockResolvedValueOnce(loginOk())
      .mockResolvedValueOnce(
        json(500, { secret: 'sk-live-123', quota: 'exceeded' }),
      );
    const client = clientWith(ENV);

    const err = await client.get('/api/models').then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadGatewayException);
    expect((err as Error).message).toBe('FreeLLMAPI request failed');
    expect((err as Error).message).not.toContain('sk-live-123');
  });
});
