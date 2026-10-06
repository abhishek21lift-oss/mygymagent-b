import {
  BadGatewayException,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AdminAiService, sanitizeUnknown } from './admin-ai.service';
import { FreellmClient } from './freellm.client';

function mockClient(overrides: Partial<Record<string, jest.Mock>> = {}) {
  const base = {
    get: jest.fn(),
    post: jest.fn(),
    put: jest.fn(),
    patch: jest.fn(),
    del: jest.fn(),
    getPublic: jest.fn(),
  };
  return { ...base, ...overrides } as unknown as FreellmClient;
}

function mockAudit(): { record: jest.Mock } {
  return { record: jest.fn().mockResolvedValue(undefined) };
}

const ctx = {
  actorUserId: 'u1',
  ipAddress: '1.2.3.4',
  userAgent: 'jest',
  requestId: 'r1',
};

describe('sanitizeUnknown', () => {
  it('strips secret fields but keeps masked variants', () => {
    const out = sanitizeUnknown({
      key: 'sk-secret',
      maskedKey: 'sk-…1234',
      nested: { token: 'abc', label: 'x' },
    }) as Record<string, unknown>;
    expect(out.key).toBeUndefined();
    expect(out.maskedKey).toBe('sk-…1234');
    expect((out.nested as Record<string, unknown>).token).toBeUndefined();
  });

  it('strips key-like values even under unknown names', () => {
    const out = sanitizeUnknown({ custom: 'freellmapi-abcdef' }) as Record<
      string,
      unknown
    >;
    expect(out.custom).toBeUndefined();
  });
});

describe('AdminAiService', () => {
  describe('gateway diagnosis', () => {
    function gatewayClient(opts: {
      publicFails?: Error;
      getFails?: Error;
      configured?: boolean;
      loopback?: boolean;
    }) {
      return {
        ...mockClient({
          getPublic: opts.publicFails
            ? jest.fn().mockRejectedValue(opts.publicFails)
            : jest.fn().mockResolvedValue({ status: 'ok' }),
          get: opts.getFails
            ? jest.fn().mockRejectedValue(opts.getFails)
            : jest.fn().mockResolvedValue([{ platform: 'openai' }]),
        }),
        isConfigured: () => opts.configured ?? true,
        usesLoopbackBaseUrl: () => opts.loopback ?? false,
      } as unknown as FreellmClient;
    }

    it('says why the gateway is offline, without leaking the URL', async () => {
      const service = new AdminAiService(
        gatewayClient({
          publicFails: new BadGatewayException('FreeLLMAPI is unreachable'),
          getFails: new ServiceUnavailableException(
            'FREELLM_EMAIL/FREELLM_PASSWORD are not configured',
          ),
          configured: false,
          loopback: true,
        }),
        mockAudit() as never,
      );
      const out = (await service.gateway()) as Record<string, unknown>;
      expect(out.state).toBe('Offline');
      expect(out.live).toEqual({
        status: 'unavailable',
        reason: 'FreeLLMAPI is unreachable',
      });
      expect(out.diagnosis).toEqual({
        credentialsConfigured: false,
        loopbackBaseUrl: true,
        providersError: 'FREELLM_EMAIL/FREELLM_PASSWORD are not configured',
      });
      expect(JSON.stringify(out)).not.toMatch(/127\.0\.0\.1|http:/);
    });

    it('reports a healthy gateway with a clean diagnosis', async () => {
      const service = new AdminAiService(
        gatewayClient({}),
        mockAudit() as never,
      );
      const out = (await service.gateway()) as Record<string, unknown>;
      expect(out.state).toBe('Healthy');
      expect(out.diagnosis).toEqual({
        credentialsConfigured: true,
        loopbackBaseUrl: false,
        providersError: null,
      });
    });
  });

  it('analytics requests strip clientIp/UA and truncate errors', async () => {
    const client = mockClient({
      get: jest.fn().mockResolvedValue({
        total: 1,
        rows: [
          {
            id: 1,
            clientIp: '9.9.9.9',
            clientUserAgent: 'curl',
            error: 'x'.repeat(500),
            modelId: 'm',
          },
        ],
      }),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    const out = (await svc.analyticsRequests({})) as {
      rows: Record<string, unknown>[];
    };
    expect(out.rows[0].clientIp).toBeUndefined();
    expect(out.rows[0].clientUserAgent).toBeUndefined();
    expect((out.rows[0].error as string).length).toBeLessThanOrEqual(300);
  });

  it('models list strips keyId/keyLabel', async () => {
    const client = mockClient({
      get: jest
        .fn()
        .mockResolvedValue([
          { id: 1, keyId: 5, keyLabel: 'prod', modelId: 'm' },
        ]),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    const out = (await svc.models()) as Record<string, unknown>[];
    expect(out[0].keyId).toBeUndefined();
    expect(out[0].modelId).toBe('m');
  });

  it('malformed models response maps to 400, not a crash', async () => {
    const client = mockClient({
      get: jest.fn().mockResolvedValue({ nope: true }),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(svc.models()).rejects.toBeInstanceOf(BadRequestException);
  });

  it('FreeLLMAPI unreachable propagates as 502/503 (no secret leak)', async () => {
    const client = mockClient({
      get: jest
        .fn()
        .mockRejectedValue(
          new BadGatewayException('FreeLLMAPI is unreachable'),
        ),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(svc.providers()).rejects.toBeInstanceOf(BadGatewayException);
  });

  it('rejects absolute/blocked proxy URLs (SSRF guard)', async () => {
    const client = mockClient({ post: jest.fn() });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(
      svc.createKey(
        { platform: 'openai', proxyUrl: 'http://169.254.169.254/x' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.createKey(
        { platform: 'openai', proxyUrl: 'file:///etc/passwd' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(client.post).not.toHaveBeenCalled();
  });

  it('rejects invalid ids (IDOR-shaped input)', async () => {
    const client = mockClient({ del: jest.fn() });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(svc.deleteKey('../../etc', ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(client.del).not.toHaveBeenCalled();
  });

  it('rejects unsupported routing strategies (allowlist)', async () => {
    const client = mockClient({ put: jest.fn() });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(
      svc.updateRouting({ strategy: 'turbo-ultra' }, ctx),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects duplicate modelDbId in fallback chain', async () => {
    const client = mockClient({ put: jest.fn() });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(
      svc.updateFallback(
        [
          { modelDbId: 1, priority: 0, enabled: true },
          { modelDbId: 1, priority: 1, enabled: true },
        ],
        ctx,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects non-writable settings sections', async () => {
    const client = mockClient({ put: jest.fn() });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(svc.updateSettings('api-key', {}, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.updateSettings('proxy', {}, ctx)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('records audit on mutation without secrets', async () => {
    const client = mockClient({
      post: jest.fn().mockResolvedValue({ id: 7, maskedKey: 'sk-…1' }),
    });
    const audit = mockAudit();
    const svc = new AdminAiService(client, audit as never);
    await svc.createKey(
      { platform: 'openai', key: 'sk-RAW-NEVER-LOG', label: 'p' },
      ctx,
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    const entry = audit.record.mock.calls[0][0];
    expect(entry.action).toBe('keys.create');
    expect(JSON.stringify(entry.afterState)).not.toContain('sk-RAW-NEVER-LOG');
    expect(entry.actorUserId).toBe('u1');
  });

  it('create/rotate client profile returns raw key once (caller responsibility: show-once)', async () => {
    const client = mockClient({
      post: jest
        .fn()
        .mockResolvedValue({ id: 3, name: 'ci', key: 'sk-cp-RAW' }),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    const out = (await svc.createClientProfile({ name: 'ci' }, ctx)) as Record<
      string,
      unknown
    >;
    expect(out.key).toBe('sk-cp-RAW');
  });

  it('unconfigured FreeLLMAPI surfaces 503', async () => {
    const client = mockClient({
      get: jest
        .fn()
        .mockRejectedValue(
          new ServiceUnavailableException(
            'FREELLM_EMAIL/FREELLM_PASSWORD are not configured',
          ),
        ),
    });
    const svc = new AdminAiService(client, mockAudit() as never);
    await expect(svc.providers()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});

describe('FreellmClient path blocklist', () => {
  it('blocks secret-exfil paths without network', async () => {
    const config = {
      get: (k: string) =>
        ({
          FREELLM_EMAIL: 'a@b.c',
          FREELLM_PASSWORD: 'x',
          FREELLM_TIMEOUT_MS: 1000,
        })[k],
    } as never;
    const client = new FreellmClient(config);
    await expect(client.get('/api/keys/export')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(client.post('/api/keys/1/reveal')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(client.get('/api/settings/api-key')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
    await expect(client.get('https://evil.example/x')).rejects.toBeInstanceOf(
      BadGatewayException,
    );
  });
});
