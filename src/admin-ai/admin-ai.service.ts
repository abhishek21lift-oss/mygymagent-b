import { BadRequestException, Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { FreellmClient } from './freellm.client';
import { WRITABLE_SETTINGS_SECTIONS } from './dto';

const SECRET_KEYS = new Set([
  'key',
  'apiKey',
  'api_key',
  'token',
  'apiKeyHash',
  'token_hash',
  'encrypted_key',
  'encryptedKey',
  'authorization',
  'fetchRelayToken',
  'unified_api_key',
  'apiKeyPreview',
]);

const ERROR_TRUNCATE = 300;

/** Strip any secret-shaped fields; keep only masked* variants. */
export function sanitizeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeUnknown);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEYS.has(k)) continue;
      if (typeof v === 'string' && isSecretValue(v)) continue;
      out[k] = sanitizeUnknown(v);
    }
    return out;
  }
  return value;
}

function isSecretValue(v: string): boolean {
  if (v.includes('…') || v.includes('***') || v.includes('•••')) return false;
  return /^(sk-|freellmapi-|gsk_|sk-ant-|AIza|xox|ghp_)/.test(v);
}

function truncateError(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, ERROR_TRUNCATE);
  return value;
}

function sanitizeRequestRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const { clientIp, clientUserAgent, client_ip, client_user_agent, ...rest } =
    row as Record<string, unknown> & {
      clientIp?: unknown;
      clientUserAgent?: unknown;
      client_ip?: unknown;
      client_user_agent?: unknown;
    };
  void clientIp;
  void clientUserAgent;
  void client_ip;
  void client_user_agent;
  const clean = sanitizeUnknown(rest) as Record<string, unknown>;
  return { ...clean, error: truncateError(clean.error) };
}

export interface AuditCtx {
  actorUserId: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

@Injectable()
export class AdminAiService {
  constructor(
    private readonly freellm: FreellmClient,
    private readonly audit: AuditService,
  ) {}

  private async record(
    ctx: AuditCtx,
    action: string,
    resourceId?: string | null,
    afterState?: unknown,
  ): Promise<void> {
    await this.audit.record({
      organizationId: null,
      actorUserId: ctx.actorUserId,
      action,
      resource: 'ai_gateway',
      resourceId: resourceId ?? null,
      afterState: (sanitizeUnknown(afterState ?? {}) ?? {}) as object,
      ipAddress: ctx.ipAddress ?? null,
      userAgent: ctx.userAgent ?? null,
      requestId: ctx.requestId ?? null,
    });
  }

  // -- Gateway -----------------------------------------------------------
  async gateway(): Promise<unknown> {
    const [live, ready, ping, providers] = await Promise.all([
      this.freellm.getPublic('/livez').catch(() => ({ status: 'unavailable' })),
      this.freellm
        .getPublic('/readyz')
        .catch(() => ({ status: 'unavailable' })),
      this.freellm.getPublic('/api/ping').catch(() => null),
      this.freellm.get('/api/keys/providers').catch(() => null),
    ]);
    const readyStatus = (ready as { status?: string })?.status;
    const liveStatus = (live as { status?: string })?.status;
    let state: string = 'Healthy';
    if (liveStatus !== 'ok' && readyStatus !== 'ok') state = 'Offline';
    else if (readyStatus !== 'ok') state = 'Critical';
    else if (JSON.stringify(providers ?? '').includes('rate_limited'))
      state = 'Warning';
    return sanitizeUnknown({ state, live, ready, ping, providers });
  }

  providers(): Promise<unknown> {
    return this.freellm
      .get('/api/keys/providers')
      .then((v) => sanitizeUnknown(v));
  }

  // -- Keys ---------------------------------------------------------------
  keys(): Promise<unknown> {
    return this.freellm.get('/api/keys/').then((v) => sanitizeUnknown(v));
  }

  async createKey(
    body: { platform: string; key?: string; label?: string; proxyUrl?: string },
    ctx: AuditCtx,
  ): Promise<unknown> {
    this.assertNoUrlForward(body.proxyUrl);
    const created = await this.freellm.post('/api/keys/', body);
    await this.record(ctx, 'keys.create', undefined, {
      platform: body.platform,
      label: body.label,
    });
    return sanitizeUnknown(created);
  }

  async patchKey(
    id: string,
    body: Record<string, unknown>,
    ctx: AuditCtx,
  ): Promise<unknown> {
    this.assertId(id);
    this.assertNoUrlForward((body as { proxyUrl?: string }).proxyUrl);
    const updated = await this.freellm.patch(
      `/api/keys/${encodeURIComponent(id)}`,
      body,
    );
    await this.record(ctx, 'keys.patch', id, {
      id,
      ...(sanitizeUnknown(body) as Record<string, unknown>),
    });
    return sanitizeUnknown(updated);
  }

  async deleteKey(id: string, ctx: AuditCtx): Promise<unknown> {
    this.assertId(id);
    const out = await this.freellm.del(`/api/keys/${encodeURIComponent(id)}`);
    await this.record(ctx, 'keys.delete', id, { id });
    return sanitizeUnknown(out);
  }

  async checkKey(id: string): Promise<unknown> {
    this.assertId(id);
    return sanitizeUnknown(
      await this.freellm.post(`/api/health/check/${encodeURIComponent(id)}`),
    );
  }

  checkAll(ctx: AuditCtx): Promise<unknown> {
    return this.freellm.post('/api/health/check-all').then(async (v) => {
      await this.record(ctx, 'keys.check-all', null, {});
      return sanitizeUnknown(v);
    });
  }

  async clearCooldowns(id: string, ctx: AuditCtx): Promise<unknown> {
    this.assertId(id);
    const out = await this.freellm.del(
      `/api/keys/${encodeURIComponent(id)}/cooldowns`,
    );
    await this.record(ctx, 'keys.clear-cooldowns', id, { id });
    return sanitizeUnknown(out);
  }

  // -- Models ---------------------------------------------------------------
  models(): Promise<unknown> {
    return this.freellm.get('/api/models/').then((rows) => {
      if (!Array.isArray(rows))
        throw new BadRequestException('Unexpected models response');
      return (rows as Record<string, unknown>[]).map(
        ({ keyId, keyLabel, ...rest }) => sanitizeUnknown(rest),
      );
    });
  }

  async patchModel(
    id: string,
    body: Record<string, unknown>,
    ctx: AuditCtx,
  ): Promise<unknown> {
    this.assertId(id);
    const allowed = [
      'displayName',
      'enabled',
      'fallbackEnabled',
      'rpmLimit',
      'rpdLimit',
      'tpmLimit',
      'tpdLimit',
      'supportsTools',
      'supportsVision',
    ];
    const picked: Record<string, unknown> = {};
    for (const k of allowed) if (body[k] !== undefined) picked[k] = body[k];
    const out = await this.freellm.patch(
      `/api/models/${encodeURIComponent(id)}`,
      picked,
    );
    await this.record(ctx, 'models.patch', id, {
      id,
      ...(sanitizeUnknown(picked) as Record<string, unknown>),
    });
    return sanitizeUnknown(out);
  }

  // -- Fallback & routing ------------------------------------------------------
  fallback(): Promise<unknown> {
    return this.freellm.get('/api/fallback/').then((rows) => {
      if (!Array.isArray(rows))
        throw new BadRequestException('Unexpected fallback response');
      return (rows as Record<string, unknown>[]).map(
        ({ keyId, keyLabel, ...rest }) => sanitizeUnknown(rest),
      );
    });
  }

  async updateFallback(
    rows: { modelDbId: number; priority: number; enabled: boolean }[],
    ctx: AuditCtx,
  ): Promise<unknown> {
    if (!Array.isArray(rows) || rows.length > 500)
      throw new BadRequestException('Invalid fallback chain');
    const ids = new Set(rows.map((r) => r.modelDbId));
    if (ids.size !== rows.length)
      throw new BadRequestException('Duplicate modelDbId in chain');
    const out = await this.freellm.put('/api/fallback/', rows);
    await this.record(ctx, 'fallback.update', null, { count: rows.length });
    return sanitizeUnknown(out);
  }

  async routing(): Promise<unknown> {
    const [routing, penalties] = await Promise.all([
      this.freellm.get('/api/fallback/routing').catch(() => null),
      this.freellm.get('/api/fallback/penalty-inspector').catch(() => null),
    ]);
    return sanitizeUnknown({ routing, penalties });
  }

  async updateRouting(
    body: Record<string, unknown>,
    ctx: AuditCtx,
  ): Promise<unknown> {
    const allowedStrategies = [
      'priority',
      'balanced',
      'smartest',
      'fastest',
      'reliable',
      'custom',
    ];
    if (!allowedStrategies.includes(String(body.strategy)))
      throw new BadRequestException('Unsupported routing strategy');
    const out = await this.freellm.put('/api/fallback/routing', body);
    await this.record(ctx, 'routing.update', null, sanitizeUnknown(body));
    return sanitizeUnknown(out);
  }

  // -- Quota --------------------------------------------------------------------
  async quota(): Promise<unknown> {
    const [tokenUsage, rateUsage, freeTier] = await Promise.all([
      this.freellm.get('/api/fallback/token-usage').catch(() => null),
      this.freellm.get('/api/fallback/rate-limit-usage').catch(() => null),
      this.freellm.get('/api/free-tier/').catch(() => null),
    ]);
    return sanitizeUnknown({ tokenUsage, rateUsage, freeTier });
  }

  // -- Analytics ------------------------------------------------------------------
  analyticsSummary(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.freellm
      .get('/api/analytics/summary', query)
      .then((v) => sanitizeUnknown(v));
  }

  analyticsByModel(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.freellm
      .get('/api/analytics/by-model', query)
      .then((v) => sanitizeUnknown(v));
  }

  analyticsByPlatform(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.freellm
      .get('/api/analytics/by-platform', query)
      .then((v) => sanitizeUnknown(v));
  }

  analyticsTimeline(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return this.freellm
      .get('/api/analytics/timeline', query)
      .then((v) => sanitizeUnknown(v));
  }

  async analyticsRequests(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const data = await this.freellm.get<{
      total?: number;
      rows?: Record<string, unknown>[];
    }>('/api/analytics/requests', query);
    if (data && Array.isArray(data.rows)) {
      return {
        total: data.total ?? data.rows.length,
        rows: data.rows.map(sanitizeRequestRow),
      };
    }
    return sanitizeUnknown(data);
  }

  // -- Logs -------------------------------------------------------------------------
  logs(query: Record<string, string | number | undefined>): Promise<unknown> {
    return this.freellm
      .get('/api/logs/', query)
      .then((v) => sanitizeUnknown(v));
  }

  // -- Settings -----------------------------------------------------------------------
  settings(): Promise<unknown> {
    return Promise.all([
      this.freellm.get('/api/settings/version').catch(() => null),
      this.freellm.get('/api/settings/compression').catch(() => null),
      this.freellm.get('/api/settings/fusion').catch(() => null),
      this.freellm.get('/api/settings/anthropic-map').catch(() => null),
      this.freellm.get('/api/settings/gemini-map').catch(() => null),
      this.freellm.get('/api/settings/agent-compatibility').catch(() => null),
      this.freellm.get('/api/settings/guardrails').catch(() => null),
      this.freellm.get('/api/settings/headroom').catch(() => null),
      this.freellm.get('/api/settings/output-limit').catch(() => null),
      this.freellm.get('/api/settings/unify').catch(() => null),
      this.freellm.get('/api/settings/proxy').catch(() => null),
      this.freellm.get('/api/settings/update-check').catch(() => null),
    ]).then(
      ([
        version,
        compression,
        fusion,
        anthropicMap,
        geminiMap,
        agentCompat,
        guardrails,
        headroom,
        outputLimit,
        unify,
        proxy,
        updateCheck,
      ]) =>
        sanitizeUnknown({
          version,
          compression,
          fusion,
          anthropicMap,
          geminiMap,
          agentCompat,
          guardrails,
          headroom,
          outputLimit,
          unify,
          proxy,
          updateCheck,
        }),
    );
  }

  async updateSettings(
    section: string,
    value: Record<string, unknown>,
    ctx: AuditCtx,
  ): Promise<unknown> {
    if (!(WRITABLE_SETTINGS_SECTIONS as readonly string[]).includes(section)) {
      throw new BadRequestException('Settings section is not writable in V1');
    }
    const out = await this.freellm.put(`/api/settings/${section}`, value);
    await this.record(ctx, 'settings.update', section, { section });
    return sanitizeUnknown(out);
  }

  // -- Backups --------------------------------------------------------------------------
  backups(
    query: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    return Promise.all([
      this.freellm.get('/api/backups/', query).catch(() => null),
      this.freellm.get('/api/backups/schedule').catch(() => null),
      this.freellm.get('/api/backups/tables').catch(() => null),
    ]).then(([list, schedule, tables]) =>
      sanitizeUnknown({ list, schedule, tables }),
    );
  }

  async createBackup(
    body: { tables?: string[] },
    ctx: AuditCtx,
  ): Promise<unknown> {
    const out = await this.freellm.post('/api/backups/', body ?? {});
    await this.record(ctx, 'backups.create', null, {});
    return sanitizeUnknown(out);
  }

  // -- Client profiles ---------------------------------------------------------------------
  clientProfiles(): Promise<unknown> {
    return this.freellm
      .get('/api/client-profiles/')
      .then((v) => sanitizeUnknown(v));
  }

  async createClientProfile(
    body: { name: string; systemPrompt?: string | null },
    ctx: AuditCtx,
  ): Promise<unknown> {
    const created = (await this.freellm.post(
      '/api/client-profiles/',
      body,
    )) as Record<string, unknown>;
    await this.record(ctx, 'client-profiles.create', String(created.id ?? ''), {
      name: body.name,
    });
    // Show-once: return raw key exactly once, never store/log it here.
    if (created.key !== undefined) {
      const { key, ...rest } = created;
      return { ...(sanitizeUnknown(rest) as Record<string, unknown>), key };
    }
    return sanitizeUnknown(created);
  }

  async rotateClientProfile(id: string, ctx: AuditCtx): Promise<unknown> {
    this.assertId(id);
    const rotated = (await this.freellm.post(
      `/api/client-profiles/${encodeURIComponent(id)}/rotate`,
    )) as Record<string, unknown>;
    await this.record(ctx, 'client-profiles.rotate', id, { id });
    if (rotated.key !== undefined) {
      const { key, ...rest } = rotated;
      return { ...(sanitizeUnknown(rest) as Record<string, unknown>), key };
    }
    return sanitizeUnknown(rotated);
  }

  async patchClientProfile(
    id: string,
    body: Record<string, unknown>,
    ctx: AuditCtx,
  ): Promise<unknown> {
    this.assertId(id);
    const out = await this.freellm.patch(
      `/api/client-profiles/${encodeURIComponent(id)}`,
      body,
    );
    await this.record(ctx, 'client-profiles.patch', id, { id });
    return sanitizeUnknown(out);
  }

  async deleteClientProfile(id: string, ctx: AuditCtx): Promise<unknown> {
    this.assertId(id);
    const out = await this.freellm.del(
      `/api/client-profiles/${encodeURIComponent(id)}`,
    );
    await this.record(ctx, 'client-profiles.delete', id, { id });
    return sanitizeUnknown(out);
  }

  // -- Embeddings / media ---------------------------------------------------------------------
  embeddings(): Promise<unknown> {
    return Promise.all([
      this.freellm.get('/api/embeddings/').catch(() => null),
      this.freellm.get('/api/embeddings/usage').catch(() => null),
    ]).then(([config, usage]) => sanitizeUnknown({ config, usage }));
  }

  media(modality?: string): Promise<unknown> {
    return Promise.all([
      this.freellm.get('/api/media/').catch(() => null),
      modality
        ? this.freellm.get('/api/media/usage', { modality }).catch(() => null)
        : Promise.resolve(null),
    ]).then(([config, usage]) => sanitizeUnknown({ config, usage }));
  }

  health(): Promise<unknown> {
    return this.freellm.get('/api/health/').then((v) => sanitizeUnknown(v));
  }

  private assertId(id: string): void {
    if (!id || typeof id !== 'string' || id.length > 64 || /[^\w-]/.test(id)) {
      throw new BadRequestException('Invalid id');
    }
  }

  /** Reject absolute URLs / SSRF-shaped proxy targets. Relative proxy
   *  schemes (http/https/socks5) to public hosts only; block private nets. */
  private assertNoUrlForward(url: string | undefined): void {
    if (!url) return;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new BadRequestException('Invalid proxy URL');
    }
    if (!['http:', 'https:', 'socks5:', 'socks5h:'].includes(parsed.protocol)) {
      throw new BadRequestException('Unsupported proxy URL scheme');
    }
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('10.') ||
      host.startsWith('192.168.') ||
      host.startsWith('172.') ||
      host.startsWith('169.254.') ||
      host.endsWith('.local') ||
      host.endsWith('.internal')
    ) {
      throw new BadRequestException('Proxy URL host is not allowed');
    }
  }
}
