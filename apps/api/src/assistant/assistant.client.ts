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
import { FREE_TOOLS } from './assistant.tools.js';

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

/**
 * Absolute ceiling on harness rounds, independent of the tool budget.
 *
 * The budget alone no longer bounds the loop now that some tools are free, so
 * this is what guarantees a turn ends at all.
 */
const MAX_ROUNDS = 12;

/**
 * Added to the final round, the one that runs with no tools attached.
 *
 * Without it a model that still wants a tool has nowhere to put the request
 * and writes the call out as prose instead — real transcripts came back as a
 * wall of `<|DSML|tool_calls><|DSML|invoke name="read_document">…`, presented
 * to the reader as the answer. Saying the budget is gone gives it somewhere to
 * go: summarize what you already have.
 */
const LAST_ROUND_NUDGE: ChatCompletionMessageParam = {
  role: 'system',
  content:
    'Your tool budget for this turn is spent — no more searching, reading or writing. Answer now, using only ' +
    'what you already gathered, and say plainly if something could not be checked. Never write tool-call ' +
    'syntax into your answer. If your answer would end by asking the user something, you may still call ' +
    'ask_user or request_agent_mode: ask with the form, not with a paragraph.',
};

/**
 * Last-resort scrub of tool-call markup that reached the prose anyway.
 *
 * Providers leak their internal call syntax under load or after a refusal, and
 * the alternative to stripping it is showing the reader machine tokens and
 * calling them an answer. Deliberately narrow: it only removes the leaked
 * block, never rewrites the model's actual words.
 */
function stripToolMarkup(content: string): string {
  if (!content.includes('DSML') && !content.includes('tool_calls')) return content;
  return content
    .replace(/<[|｜\s]*DSML[\s\S]*?(?:<\/[|｜\s]*DSML[|｜\s]*tool_calls>|$)/g, '')
    .replace(/<\/?\s*tool_calls\s*>/g, '')
    .trim();
}

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

    const free = tools.filter((t) => FREE_TOOLS.has(t.function.name));

    for (let round$ = 0; ; round$++) {
      if (round$ >= MAX_ROUNDS) return { content: '', trace };
      const budgetLeft = this.budgetLeft(trace);
      const offered = budgetLeft > 0 ? tools : free;
      const completion = await this.create({
        messages: budgetLeft > 0 ? convo : [...convo, LAST_ROUND_NUDGE],
        ...(offered.length > 0 ? { tools: offered } : {}),
      });
      const message = completion.choices[0]?.message;
      if (!message) return { content: '', trace };

      const requested = (message.tool_calls ?? []).filter(
        (c): c is ChatCompletionMessageFunctionToolCall => c.type === 'function',
      );
      if (requested.length === 0) {
        return { content: stripToolMarkup(message.content ?? ''), trace };
      }

      convo.push(message);
      // The budget is per call, not per round: one round can ask for ten tools
      // at once, and counting rounds would let it run all ten against a budget
      // of six. Everything past the line still needs a `tool` reply — the
      // protocol requires one per tool_call_id — so the overflow is answered
      // with an error instead of being dropped.
      let spent = 0;
      for (const call of requested) {
        const billable = !FREE_TOOLS.has(call.function.name);
        if (billable && spent++ >= budgetLeft) {
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'Tool budget for this turn is exhausted; answer with what you have.' }),
          });
          continue;
        }
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

  /**
   * Streaming twin of {@link runWithTools}. Same bounded loop, same access
   * control, but the model's prose is handed to `on.delta` as it arrives and
   * tool calls are announced on both edges.
   *
   * The loop is round-based: the model may narrate, call tools, and narrate
   * again. `on.roundEnd` fires with whatever prose preceded a tool round, so
   * the caller can keep that as reasoning without it leaking into the final
   * answer — only the last round is returned as `content`, exactly matching
   * the non-streaming path.
   */
  async runWithToolsStream(
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionFunctionTool[],
    execute: ToolExecutor,
    on: {
      delta: (text: string) => void;
      toolStart: (tool: string, args: string) => Promise<void> | void;
      toolEnd: (tool: string, ok: boolean) => Promise<void> | void;
      roundEnd: (text: string) => void;
    },
    /** Aborted when the client hangs up — see the controller's Stop handling. */
    signal?: AbortSignal,
  ): Promise<{ content: string; trace: AssistantToolCall[]; cancelled: boolean }> {
    const trace: AssistantToolCall[] = [];
    const convo: ChatCompletionMessageParam[] = [...messages];

    const free = tools.filter((t) => FREE_TOOLS.has(t.function.name));

    for (let round$ = 0; ; round$++) {
      if (signal?.aborted) return { content: '', trace, cancelled: true };
      // A hard stop independent of the budget: free tools do not consume it,
      // so without this a model that kept calling one could loop forever.
      if (round$ >= MAX_ROUNDS) return { content: stripToolMarkup(''), trace, cancelled: false };
      const budgetLeft = this.budgetLeft(trace);
      const offered = budgetLeft > 0 ? tools : free;
      const round = await this.createStream(
        {
          messages: budgetLeft > 0 ? convo : [...convo, LAST_ROUND_NUDGE],
          ...(offered.length > 0 ? { tools: offered } : {}),
        },
        on.delta,
        signal,
      );

      if (round.cancelled) return { content: stripToolMarkup(round.content), trace, cancelled: true };
      if (round.toolCalls.length === 0) {
        return { content: stripToolMarkup(round.content), trace, cancelled: false };
      }

      on.roundEnd(round.content);
      convo.push({
        role: 'assistant',
        ...(round.content ? { content: round.content } : {}),
        tool_calls: round.toolCalls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments },
        })),
      });

      // Per call, not per round — see the note in runWithTools. Free tools are
      // always let through; only billable calls are rationed.
      let spent = 0;
      for (const call of round.toolCalls) {
        const billable = !FREE_TOOLS.has(call.name);
        if (billable && spent++ >= budgetLeft) {
          convo.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ error: 'Tool budget for this turn is exhausted; answer with what you have.' }),
          });
          continue;
        }
        // A cancelled turn stops before the next side effect. Tools can create
        // pages and open merge requests, so "stop" has to mean stop *before*
        // one of those runs, not merely stop showing the user the result.
        if (signal?.aborted) return { content: round.content, trace, cancelled: true };
        await on.toolStart(call.name, call.arguments.slice(0, 500));
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
        } catch {
          // Invalid JSON from the model — run with no args so it gets a
          // structured error back instead of the stream dying.
        }
        let result: ToolExecutionResult;
        try {
          result = await execute(call.name, args);
        } catch (err) {
          this.logger.warn(`Tool ${call.name} failed: ${err instanceof Error ? err.message : err}`);
          result = { content: JSON.stringify({ error: 'Tool execution failed' }), ok: false };
        }
        const ok = result.ok ?? true;
        trace.push({ tool: call.name, arguments: call.arguments.slice(0, 500), ok });
        await on.toolEnd(call.name, ok);
        convo.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result.content.slice(0, MAX_TOOL_RESULT_CHARS),
        });
      }
    }
  }

  /**
   * One streamed completion. Tool calls arrive as fragments keyed by `index`
   * (a name in one chunk, arguments split across many), so they are
   * reassembled here rather than by every caller.
   */
  private async createStream(
    params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, 'model' | 'temperature' | 'stream'>,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    cancelled: boolean;
  }> {
    if (!this.client) throw new ServiceUnavailableException('Assistant provider is disabled (ASSISTANT_PROVIDER=none)');
    let content = '';
    const partial = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      const stream = await this.client.chat.completions.create(
        { model: this.model, temperature: 0.2, stream: true, ...params },
        signal ? { signal } : undefined,
      );
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        for (const call of delta.tool_calls ?? []) {
          const slot = partial.get(call.index) ?? { id: '', name: '', arguments: '' };
          if (call.id) slot.id = call.id;
          if (call.function?.name) slot.name = call.function.name;
          if (call.function?.arguments) slot.arguments += call.function.arguments;
          partial.set(call.index, slot);
        }
      }
    } catch (err) {
      // A cancelled request rejects like any other; the text produced up to
      // that point is still real, and the caller decides what to keep.
      if (signal?.aborted) return { content, toolCalls: [], cancelled: true };
      throw this.upstreamError(err);
    }
    return {
      content,
      toolCalls: [...partial.values()].filter((c) => c.name),
      cancelled: false,
    };
  }

  private async create(
    params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model' | 'temperature'>,
  ) {
    if (!this.client) throw new ServiceUnavailableException('Assistant provider is disabled (ASSISTANT_PROVIDER=none)');
    try {
      return await this.client.chat.completions.create({ model: this.model, temperature: 0.2, ...params });
    } catch (err) {
      throw this.upstreamError(err);
    }
  }

  /** Billable calls only — asking the user something is free, see FREE_TOOLS. */
  private budgetLeft(trace: AssistantToolCall[]): number {
    return this.maxToolCalls - trace.filter((c) => !FREE_TOOLS.has(c.tool)).length;
  }

  private upstreamError(err: unknown): ServiceUnavailableException {
    if (err instanceof OpenAI.APIError) {
      this.logger.warn(`Assistant upstream ${err.status}: ${String(err.message).slice(0, 300)}`);
      return new ServiceUnavailableException(`Assistant provider responded ${err.status ?? 'with an error'}`);
    }
    this.logger.warn(`Assistant request failed: ${err instanceof Error ? err.message : String(err)}`);
    return new ServiceUnavailableException('Assistant provider unreachable');
  }
}
