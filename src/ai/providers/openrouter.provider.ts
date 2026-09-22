import {
  BadGatewayException,
  HttpException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AI_TOOL_DEFINITIONS } from '../tools/tool-definitions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenRouterToolCall[];
}

export interface OpenRouterToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface OpenRouterUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /// USD -- only present when OpenRouter reports generation cost (requested
  /// via `usage: { include: true }` below); left undefined otherwise rather
  /// than estimated, per docs/architecture/discovery-report.md's "never
  /// guess a financial-adjacent number" call.
  costUsd?: number;
}

export interface OpenRouterCompletion {
  message: ChatMessage;
  usage?: OpenRouterUsage;
  model?: string;
}

interface OpenRouterResponse {
  model?: string;
  choices: { message: ChatMessage }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    cost?: number;
  };
}

const REQUEST_TIMEOUT_MS = 45_000;
// Hard cap on completion length per call -- one lever from
// docs/ai/architecture.md's "§58 -- cost control" section; per-tenant
// usage tracking/budgets are the natural next layer, not built yet (see
// ai/README.md).
const MAX_OUTPUT_TOKENS = 2000;
// Bounded retry for transient upstream failures (429/5xx/network).
const MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Map an upstream OpenRouter failure to a safe client-facing HTTP status.
 * Never echoes the provider response body to API clients (bodies can contain
 * account/credit/model details) — the body is logged server-side instead.
 */
function toProviderHttpException(status: number): HttpException {
  if (status === 429) {
    return new HttpException(
      'AI provider is rate limiting requests. Please retry shortly.',
      429,
    );
  }
  if (status === 401 || status === 402 || status === 403) {
    return new ServiceUnavailableException(
      'AI provider is unavailable (credential or quota issue). Please retry later.',
    );
  }
  if (status >= 500) {
    return new BadGatewayException(
      'AI provider returned an error. Please retry shortly.',
    );
  }
  return new BadGatewayException(
    'AI provider request failed. Please retry shortly.',
  );
}

/**
 * Thin adapter over OpenRouter's OpenAI-compatible chat completions API.
 * Isolated behind this one class per docs/integrations/overview.md's
 * "every external integration sits behind an adapter" rule -- swapping
 * providers, or adding a second one, is a new class implementing the same
 * shape, not a rewrite of AiService.
 */
@Injectable()
export class OpenRouterProvider {
  private readonly logger = new Logger(OpenRouterProvider.name);

  constructor(private readonly config: ConfigService) {}

  async chatCompletion(messages: ChatMessage[]): Promise<OpenRouterCompletion> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'AI is not configured on this deployment (OPENROUTER_API_KEY is unset).',
      );
    }
    const model = this.config.get<string>('OPENROUTER_MODEL');

    let lastError: HttpException | undefined;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.attemptCompletion(apiKey, model, messages);
      } catch (error) {
        if (!(error instanceof HttpException)) {
          // Unexpected non-HTTP failure (e.g. parse error) — wrap generically.
          lastError = new BadGatewayException(
            'AI provider request failed. Please retry shortly.',
          );
          this.logger.error(
            `Unexpected provider failure (attempt ${attempt}/${MAX_ATTEMPTS}): ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        } else if (error.getStatus() === 429 || error.getStatus() >= 500) {
          lastError = error;
        } else {
          throw error; // non-retryable mapped statuses (401/402/403 → 503)
        }
        if (attempt < MAX_ATTEMPTS) {
          await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    throw lastError ?? new BadGatewayException('AI provider request failed.');
  }

  private async attemptCompletion(
    apiKey: string,
    model: string | undefined,
    messages: ChatMessage[],
  ): Promise<OpenRouterCompletion> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages,
          tools: AI_TOOL_DEFINITIONS,
          max_tokens: MAX_OUTPUT_TOKENS,
          usage: { include: true },
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        this.logger.warn(
          `OpenRouter error ${res.status}: ${body.slice(0, 500)}`,
        );
        const mapped = toProviderHttpException(res.status);
        if (RETRYABLE_STATUS.has(res.status)) {
          // Mark as retryable by rethrowing with status preserved.
          throw mapped;
        }
        throw mapped;
      }

      let json: OpenRouterResponse;
      try {
        json = (await res.json()) as OpenRouterResponse;
      } catch {
        this.logger.error('OpenRouter returned unparseable JSON body.');
        throw new BadGatewayException(
          'AI provider returned an invalid response. Please retry shortly.',
        );
      }
      const message = json.choices?.[0]?.message;
      if (!message) {
        this.logger.error('OpenRouter returned no completion choices.');
        throw new BadGatewayException(
          'AI provider returned no completion. Please retry shortly.',
        );
      }
      const usage: OpenRouterUsage | undefined = json.usage
        ? {
            promptTokens: json.usage.prompt_tokens,
            completionTokens: json.usage.completion_tokens,
            totalTokens: json.usage.total_tokens,
            costUsd: json.usage.cost,
          }
        : undefined;
      return { message, usage, model: json.model ?? model };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceUnavailableException(
          `AI provider request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      this.logger.error(
        `OpenRouter network failure: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new BadGatewayException(
        'AI provider is unreachable. Please retry shortly.',
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
