import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Server-side-only FreeLLMAPI management HTTP client.
 *
 * Uses the existing dashboard session mechanism (POST /api/auth/login)
 * held entirely in this backend process. The session token, dashboard
 * password, and any provider secrets are never returned to callers and
 * never logged. Only explicit relative paths from the allowlist are
 * ever requested -- no arbitrary URL forwarding.
 */
const BLOCKED_SUBSTRINGS = [
  '/export',
  '/reveal',
  '/preview',
  '/api-key',
  '/download',
  '/restore',
  '/premium',
  '/url-tokens',
  '/conversations',
  '/clear',
  'import-selected',
];

function isBlocked(path: string): boolean {
  if (!path.startsWith('/')) return true;
  if (path.includes('..') || path.includes('://')) return true;
  return BLOCKED_SUBSTRINGS.some((s) => path.includes(s));
}

@Injectable()
export class FreellmClient {
  private readonly logger = new Logger(FreellmClient.name);
  private sessionToken: string | null = null;
  private loginInFlight: Promise<string> | null = null;

  constructor(private readonly config: ConfigService) {}

  isConfigured(): boolean {
    return (
      Boolean(this.config.get<string>('FREELLM_EMAIL')) &&
      Boolean(this.config.get<string>('FREELLM_PASSWORD'))
    );
  }

  /**
   * Whether the base URL still points at this machine. The env default is
   * `http://127.0.0.1:3001`, which only works when FreeLLMAPI runs beside
   * the API; on a hosted deploy it means the variable was never set. A
   * boolean, never the URL itself -- the console must not learn internal
   * hostnames.
   */
  usesLoopbackBaseUrl(): boolean {
    try {
      const host = new URL(this.baseUrl()).hostname;
      return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
    } catch {
      return false;
    }
  }

  private baseUrl(): string {
    return (
      this.config.get<string>('FREELLM_BASE_URL') ?? 'http://127.0.0.1:3001'
    ).replace(/\/$/, '');
  }

  private timeoutMs(): number {
    return this.config.get<number>('FREELLM_TIMEOUT_MS') ?? 15000;
  }

  async get<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.request<T>('GET', path, undefined, query);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body);
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  async del<T>(
    path: string,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    return this.request<T>('DELETE', path, undefined, query);
  }

  /** Raw unauthenticated GET for /livez, /readyz, /api/ping. */
  async getPublic<T>(path: string): Promise<T> {
    if (isBlocked(path))
      throw new BadGatewayException('Blocked FreeLLMAPI path');
    return this.fetchJson<T>('GET', `${this.baseUrl()}${path}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<T> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException(
        'FREELLM_EMAIL/FREELLM_PASSWORD are not configured',
      );
    }
    if (isBlocked(path))
      throw new BadGatewayException('Blocked FreeLLMAPI path');
    let qs = '';
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query))
        if (v !== undefined) params.set(k, String(v));
      const s = params.toString();
      if (s) qs = `?${s}`;
    }
    const token = await this.ensureSession();
    const url = `${this.baseUrl()}${path}${qs}`;
    try {
      return await this.fetchJson<T>(method, url, token, body);
    } catch (err) {
      if (
        err instanceof BadGatewayException &&
        (err as { retriable?: boolean }).retriable
      ) {
        // Session expired -- re-login once and retry.
        this.sessionToken = null;
        const fresh = await this.ensureSession(true);
        return this.fetchJson<T>(method, url, fresh, body);
      }
      throw err;
    }
  }

  private async ensureSession(force = false): Promise<string> {
    if (this.sessionToken && !force) return this.sessionToken;
    if (!this.loginInFlight || force) {
      this.loginInFlight = this.login()
        .then((t) => {
          this.sessionToken = t;
          this.loginInFlight = null;
          return t;
        })
        .catch((err) => {
          this.loginInFlight = null;
          throw err;
        });
    }
    return this.loginInFlight;
  }

  private async login(): Promise<string> {
    const email = this.config.get<string>('FREELLM_EMAIL');
    const password = this.config.get<string>('FREELLM_PASSWORD');
    if (!email || !password) {
      throw new ServiceUnavailableException(
        'FREELLM_EMAIL/FREELLM_PASSWORD are not configured',
      );
    }
    const data = await this.fetchJson<{ token?: string }>(
      'POST',
      `${this.baseUrl()}/api/auth/login`,
      undefined,
      { email, password },
    );
    if (!data || typeof data.token !== 'string' || !data.token) {
      throw new BadGatewayException(
        'FreeLLMAPI login returned an unexpected response',
      );
    }
    return data.token;
  }

  private async fetchJson<T>(
    method: string,
    url: string,
    token?: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      const res = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.status === 401 && token) {
        const err = new BadGatewayException(
          'FreeLLMAPI session expired',
        ) as BadGatewayException & { retriable?: boolean };
        err.retriable = true;
        throw err;
      }
      if (res.status === 401) {
        // No session token on the way out means this was the dashboard
        // login itself: the gateway rejected the configured credentials.
        // Deliberately distinct from the generic failure below, so the
        // Command Center diagnosis can tell "wrong credentials" apart
        // from "unreachable" -- same HTTP 502 family, actionable text.
        // The address is never included: it is config, not diagnostics.
        throw new BadGatewayException(
          'FreeLLMAPI rejected the dashboard credentials',
        );
      }
      if (!res.ok) {
        if (res.status === 429) {
          throw new BadGatewayException('FreeLLMAPI is rate limiting requests');
        }
        // Never echo upstream bodies (may contain key/quota detail).
        this.logger.warn(`FreeLLMAPI ${method} failed status=${res.status}`);
        throw new BadGatewayException('FreeLLMAPI request failed');
      }
      const text = await res.text();
      if (!text) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new BadGatewayException(
          'FreeLLMAPI returned a malformed response',
        );
      }
    } catch (err) {
      if (
        err instanceof BadGatewayException ||
        err instanceof ServiceUnavailableException
      )
        throw err;
      if ((err as Error)?.name === 'AbortError') {
        throw new ServiceUnavailableException('FreeLLMAPI request timed out');
      }
      throw new BadGatewayException('FreeLLMAPI is unreachable');
    } finally {
      clearTimeout(timer);
    }
  }
}
