import {
  Injectable,
  InternalServerErrorException,
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

const REQUEST_TIMEOUT_MS = 30_000;
// Hard cap on completion length per call -- one lever from
// docs/ai/architecture.md's "§58 -- cost control" section; per-tenant
// usage tracking/budgets are the natural next layer, not built yet (see
// ai/README.md).
const MAX_OUTPUT_TOKENS = 2000;

/**
 * Thin adapter over OpenRouter's OpenAI-compatible chat completions API.
 * Isolated behind this one class per docs/integrations/overview.md's
 * "every external integration sits behind an adapter" rule -- swapping
 * providers, or adding a second one, is a new class implementing the same
 * shape, not a rewrite of AiService.
 */
@Injectable()
export class OpenRouterProvider {
  constructor(private readonly config: ConfigService) {}

  async chatCompletion(messages: ChatMessage[]): Promise<OpenRouterCompletion> {
    const apiKey = this.config.get<string>('OPENROUTER_API_KEY');
    if (!apiKey) {
      throw new ServiceUnavailableException(
        'AI is not configured on this deployment (OPENROUTER_API_KEY is unset).',
      );
    }
    const model = this.config.get<string>('OPENROUTER_MODEL');

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
        throw new InternalServerErrorException(
          `AI provider request failed (${res.status}): ${body.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as OpenRouterResponse;
      const message = json.choices[0]?.message;
      if (!message) {
        throw new InternalServerErrorException(
          'AI provider returned no completion choices.',
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
      if (error instanceof Error && error.name === 'AbortError') {
        throw new InternalServerErrorException(
          `AI provider request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
