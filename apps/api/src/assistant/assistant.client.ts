import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { AssistantToolCall } from '@knowledge/contracts';
import type { Env } from '../config/env.js';

/**
 * Per-provider defaults so `ASSISTANT_PROVIDER=deepseek` works with nothing
 * but an API key. DeepSeek speaks the OpenAI wire protocol, so the official
 * `openai` SDK is the client for every provider (docs/features/09).
 */
const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
};

/** Hard ceiling for a single tool result injected back into the conversation. */
const MAX_TOOL_RESULT_CHARS = 28_000;

export interface ToolExecutionResult {
  content: string;
  ok?: boolean;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;

/**
 * Thin wrapper around the official OpenAI SDK: one place that knows the
 * provider config, temperature, error mapping, and the bounded tool-calling
 * loop (harness). Services never touch the SDK directly.
 */
@Injectable()
export class AssistantClient {
  private readonly logger = new Logger(AssistantClient.name);
  readonly enabled: boolean;
  readonly model: string;
  private readonly maxToolCalls: number;
  private readonly client: OpenAI | null;

  constructor(config: ConfigService<Env, true>) {
    const provider = config.get('ASSISTANT_PROVIDER', { infer: true });
    const defaults = PROVIDER_DEFAULTS[provider];
    this.enabled = provider !== 'none';
    this.model = config.get('ASSISTANT_MODEL', { infer: true }) || defaults?.model || '';
    this.maxToolCalls = config.get('ASSISTANT_MAX_TOOL_CALLS', { infer: true });
    const baseURL = (config.get('ASSISTANT_BASE_URL', { infer: true }) || defaults?.baseUrl || '').replace(/\/$/, '');
    this.client = this.enabled
      ? new OpenAI({
          baseURL: baseURL || undefined,
          // Local OpenAI-compatible servers (Ollama, LM Studio) need no key.
          apiKey: config.get('ASSISTANT_API_KEY', { infer: true }) || 'unused',
          timeout: config.get('ASSISTANT_TIMEOUT_MS', { infer: true }),
          maxRetries: 1,
        })
      : null;
  }

  /** Single-shot completion (review / suggest). `json` asks for a JSON object response. */
  async chat(messages: ChatCompletionMessageParam[], opts?: { json?: boolean }): Promise<string> {
    const completion = await this.create({
      messages,
      ...(opts?.json ? { response_format: { type: 'json_object' as const } } : {}),
    });
    return completion.choices[0]?.message?.content ?? '';
  }

  /**
   * The tool harness: a bounded agentic loop. The model may call the given
   * tools; every call is executed through `execute` (which enforces access
   * control) and the result fed back. When the budget is spent the final
   * round runs WITHOUT tools so the model must answer with what it has.
   */
  async runWithTools(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionFunctionTool[],
    execute: ToolExecutor,
  ): Promise<{ content: string; trace: AssistantToolCall[] }> {
    const trace: AssistantToolCall[] = [];
    const convo: ChatCompletionMessageParam[] = [...messages];

    for (;;) {
      const budgetLeft = trace.length < this.maxToolCalls;
      const completion = await this.create({
        messages: convo,
        ...(tools.length > 0 && budgetLeft ? { tools } : {}),
      });
      const message = completion.choices[0]?.message;
      if (!message) return { content: '', trace };

      const calls = (message.tool_calls ?? []).filter(
        (c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function',
      );
      if (calls.length === 0 || !budgetLeft) {
        return { content: message.content ?? '', trace };
      }

      convo.push(message);
      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          // The model produced invalid JSON — run the tool with no args so it
          // gets a structured error back instead of the request 500ing.
        }
        let result: ToolExecutionResult;
        try {
          result = await execute(call.function.name, args);
        } catch (err) {
          this.logger.warn(`Tool ${call.function.name} failed: ${err instanceof Error ? err.message : err}`);
          result = { content: JSON.stringify({ error: 'Tool execution failed' }), ok: false };
        }
        trace.push({
          tool: call.function.name,
          arguments: call.function.arguments.slice(0, 500),
          ok: result.ok ?? true,
        });
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content.slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
  }

  private async create(
    params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model' | 'temperature'>,
  ) {
    if (!this.client) throw new ServiceUnavailableException('Assistant provider is disabled (ASSISTANT_PROVIDER=none)');
    try {
      return await this.client.chat.completions.create({ model: this.model, temperature: 0.2, ...params });
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        this.logger.warn(`Assistant upstream ${err.status}: ${String(err.message).slice(0, 300)}`);
        throw new ServiceUnavailableException(`Assistant provider responded ${err.status ?? 'with an error'}`);
      }
      this.logger.warn(`Assistant request failed: ${err instanceof Error ? err.message : String(err)}`);
      throw new ServiceUnavailableException('Assistant provider unreachable');
    }
  }
}
