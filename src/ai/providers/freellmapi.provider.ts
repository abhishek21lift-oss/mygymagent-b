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
  tool_calls?: FreeLLMApiToolCall[];
}

export interface FreeLLMApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface FreeLLMApiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface FreeLLMApiCompletion {
  message: ChatMessage;
  usage?: FreeLLMApiUsage;
  model?: string;
}

interface FreeLLMApiResponse {
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
const MAX_OUTPUT_TOKENS = 2000;

/**
 * OpenAI-compatible FreeLLMAPI adapter.
 *
 * The provider URL, key and model are deployment configuration so the
 * application never contains provider credentials. The endpoint should be
 * the API root (for example https://host.example/v1); /chat/completions is
 * appended by this adapter.
 */
@Injectable()
export class FreeLLMApiProvider {
  constructor(private readonly config: ConfigService) {}

  async chatCompletion(messages: ChatMessage[]): Promise<FreeLLMApiCompletion> {
    const apiKey = this.config.get<string>('FREELLMAPI_API_KEY');
    const baseUrl = this.config.get<string>('FREELLMAPI_BASE_URL');
    const model = this.config.get<string>('FREELLMAPI_MODEL');

    if (!apiKey || !baseUrl || !model) {
      throw new ServiceUnavailableException(
        'AI is not configured on this deployment (FREELLMAPI_API_KEY, FREELLMAPI_BASE_URL and FREELLMAPI_MODEL are required).',
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

    try {
      const res = await fetch(endpoint, {
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
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new InternalServerErrorException(
          `AI provider request failed (${res.status}): ${body.slice(0, 500)}`,
        );
      }

      const json = (await res.json()) as FreeLLMApiResponse;
      const message = json.choices[0]?.message;
      if (!message) {
        throw new InternalServerErrorException(
          'AI provider returned no completion choices.',
        );
      }

      const usage: FreeLLMApiUsage | undefined = json.usage
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
