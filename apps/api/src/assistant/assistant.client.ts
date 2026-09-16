import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import OpenAI from 'openai';
import type {
  ChatCompletionFunctionTool,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { AssistantToolCall, AiUsageOperation } from '@knowledge/contracts';
import type { ResolvedAiConfig } from '../ai/ai-config.service.js';
import { AiUsageService, estimateTokens, type AiUsageTokens } from '../ai/ai-usage.service.js';
import { FREE_TOOLS } from './assistant.tools.js';
import type { Locale } from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { currentTrace, emitBacktest } from '@knowledge/observability';

/**
 * Everything one upstream call needs to know beyond its messages: which
 * provider config to use (feature 12 resolves it per workspace, so it is no
 * longer a boot-time constant) and who to bill the tokens to.
 */
export interface AiCallContext {
  config: ResolvedAiConfig;
  userId: string;
  operation: AiUsageOperation;
  threadId?: string;
  /**
   * Language the model must answer in (docs/features/18). Applied centrally in
   * `create`/`createStream`, so every caller gets it without editing prompts.
   */
  locale: Locale;
}

/**
 * Append the language directive to the outgoing system message (docs/features/18).
 *
 * Done here rather than in each of the prompt builders so a new entry point
 * cannot forget it. Pure — the caller's message array is never mutated, which
 * matters because runWithTools reuses one conversation across rounds.
 */
function withLocaleDirective(
  messages: ChatCompletionMessageParam[],
  locale: Locale,
): ChatCompletionMessageParam[] {
  const directive = t('prompt.localeDirective', undefined, locale);
  const at = messages.findIndex((m) => m.role === 'system');
  if (at === -1) return [{ role: 'system', content: directive }, ...messages];
  const system = messages[at];
  if (typeof system.content !== 'string') return messages;
  return messages.map((m, i) =>
    i === at ? { ...m, content: `${system.content as string}\n\n${directive}` } : m,
  );
}

/** How many distinct provider configurations keep a live SDK instance. */
const CLIENT_CACHE_MAX = 32;

/** Hard ceiling for a single tool result injected back into the conversation. */
const MAX_TOOL_RESULT_CHARS = 28_000;

/**
 * Harness rounds, derived from the tool budget rather than fixed.
 *
 * The budget alone no longer bounds the loop now that some tools are free, so
 * this is what guarantees a turn ends at all. But a constant 12 also silently
 * capped the budget: once a turn needed more than twelve rounds to spend its
 * calls, raising ASSISTANT_MAX_TOOL_CALLS bought nothing.
 *
 * MIN_ROUNDS keeps the old floor, so no turn that worked before gets shorter.
 * The +8 is headroom for narration rounds and for the free tools (ask_user,
 * request_agent_mode) that consume a round without consuming budget — the exact
 * hazard the fixed ceiling existed to contain. ROUNDS_CEILING keeps the
 * termination guarantee absolute, whatever a workspace configures.
 */
const MIN_ROUNDS = 12;
const ROUNDS_CEILING = 64;
const roundsFor = (budget: number): number =>
  Math.min(ROUNDS_CEILING, Math.max(MIN_ROUNDS, budget + 8));

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

/** Provider-reported usage → our shape. */
function fromUsage(usage: OpenAI.Completions.CompletionUsage): AiUsageTokens {
  return {
    promptTokens: usage.prompt_tokens ?? 0,
    completionTokens: usage.completion_tokens ?? 0,
    totalTokens: usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0),
    estimated: false,
  };
}

/**
 * Fallback when the provider reports nothing — several OpenAI-compatible
 * servers ignore `stream_options`, and an errored call never reports at all.
 * Flagged `estimated` so the UI can say so rather than implying billing truth.
 */
function estimateFor(messages: ChatCompletionMessageParam[], completion: string): AiUsageTokens {
  const promptChars = messages.reduce(
    (n, m) => n + (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length),
    0,
  );
  const promptTokens = estimateTokens('x'.repeat(promptChars));
  const completionTokens = estimateTokens(completion);
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens, estimated: true };
}

export interface ToolExecutionResult {
  content: string;
  ok?: boolean;
}

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolExecutionResult>;

/**
 * Thin wrapper around the official OpenAI SDK: one place that knows how a
 * resolved config becomes a client, the error mapping, the bounded
 * tool-calling loop (harness), and where token usage is recorded. Services
 * never touch the SDK directly.
 *
 * Since feature 12 the configuration arrives per call (`AiCallContext`) rather
 * than being read once in the constructor, so an admin can change model or
 * provider from the settings UI without restarting the API. SDK instances are
 * cached by the fields that actually shape a connection.
 */
@Injectable()
export class AssistantClient {
  private readonly logger = new Logger(AssistantClient.name);
  private readonly clients = new Map<string, OpenAI>();

  constructor(private readonly usage: AiUsageService) {}

  /**
   * One SDK instance per distinct (endpoint, credential, timeout). Bounded so
   * a workspace churning its settings cannot grow the map without limit; the
   * eviction is plain insertion-order (oldest first), which is enough for
   * something this small.
   */
  private clientFor(config: ResolvedAiConfig): OpenAI {
    if (!config.enabled) {
      throw new ServiceUnavailableException(t('error.assistant.providerDisabled'));
    }
    const key = `${config.baseUrl}|${config.apiKey}|${config.timeoutMs}`;
    const hit = this.clients.get(key);
    if (hit) return hit;
    const client = new OpenAI({
      baseURL: config.baseUrl || undefined,
      // Local OpenAI-compatible servers (Ollama, LM Studio) need no key.
      apiKey: config.apiKey || 'unused',
      timeout: config.timeoutMs,
      maxRetries: 1,
    });
    if (this.clients.size >= CLIENT_CACHE_MAX) {
      const oldest = this.clients.keys().next().value;
      if (oldest !== undefined) this.clients.delete(oldest);
    }
    this.clients.set(key, client);
    return client;
  }

  /** Single-shot completion (review / suggest). `json` asks for a JSON object response. */
  async chat(ctx: AiCallContext, messages: ChatCompletionMessageParam[], opts?: { json?: boolean }): Promise<string> {
    const completion = await this.create(ctx, {
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
    ctx: AiCallContext,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionFunctionTool[],
    execute: ToolExecutor,
    /**
     * Ask for a JSON object on the final, toolless round. `json_object` cannot
     * be set on a tool-calling round — it suppresses tool calls outright — so a
     * caller with a JSON output contract (the cartographer) gets it applied only
     * where no tools are offered.
     */
    opts?: { jsonFinalRound?: boolean },
  ): Promise<{ content: string; trace: AssistantToolCall[] }> {
    const trace: AssistantToolCall[] = [];
    const convo: ChatCompletionMessageParam[] = [...messages];

    const free = tools.filter((t) => FREE_TOOLS.has(t.function.name));
    const maxRounds = roundsFor(ctx.config.maxToolCalls);

    for (let round$ = 0; ; round$++) {
      // Defensive only: the last permitted round is forced toolless below, so
      // the loop normally exits through the no-tools-requested return with real
      // prose. This used to return '' — a blank bubble shown to the reader as
      // the answer, which is worse than saying plainly that nothing came back.
      if (round$ >= maxRounds) return { content: t('error.assistant.roundsExhausted'), trace };

      const budgetLeft = this.budgetLeft(ctx, trace);
      // Spending the budget is no longer the only way to reach the end: the
      // final round offers no tools at all, so a model that would otherwise keep
      // calling has to answer with what it has.
      const finalRound = round$ >= maxRounds - 1;
      const offered = finalRound ? [] : budgetLeft > 0 ? tools : free;
      const completion = await this.create(ctx, {
        messages: finalRound || budgetLeft <= 0 ? [...convo, LAST_ROUND_NUDGE] : convo,
        ...(offered.length > 0 ? { tools: offered } : {}),
        ...(opts?.jsonFinalRound && offered.length === 0
          ? { response_format: { type: 'json_object' as const } }
          : {}),
      });
      const message = completion.choices[0]?.message;
      // No choices at all is an upstream failure, not an empty answer.
      if (!message) throw this.upstreamError(new Error('Provider returned no completion choices'));

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
    ctx: AiCallContext,
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
    const maxRounds = roundsFor(ctx.config.maxToolCalls);

    for (let round$ = 0; ; round$++) {
      if (signal?.aborted) return { content: '', trace, cancelled: true };
      // A hard stop independent of the budget: free tools do not consume it,
      // so without this a model that kept calling one could loop forever.
      // Defensive only, as in runWithTools — the final round below is toolless,
      // so this used to hand the pane `stripToolMarkup('')`, an empty bubble.
      if (round$ >= maxRounds) {
        return { content: t('error.assistant.roundsExhausted'), trace, cancelled: false };
      }
      const budgetLeft = this.budgetLeft(ctx, trace);
      const finalRound = round$ >= maxRounds - 1;
      const offered = finalRound ? [] : budgetLeft > 0 ? tools : free;
      const round = await this.createStream(
        ctx,
        {
          messages: finalRound || budgetLeft <= 0 ? [...convo, LAST_ROUND_NUDGE] : convo,
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
    ctx: AiCallContext,
    params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming, 'model' | 'temperature' | 'stream'>,
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<{
    content: string;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
    cancelled: boolean;
  }> {
    const client = this.clientFor(ctx.config);
    const startedAt = Date.now();
    let content = '';
    let reported: AiUsageTokens | null = null;
    const partial = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      const stream = await client.chat.completions.create(
        {
          model: ctx.config.model,
          temperature: ctx.config.temperature,
          stream: true,
          // Feature 12: without this the stream carries no usage block at all
          // and every streamed turn would be invisible to token accounting.
          stream_options: { include_usage: true },
          ...params,
          messages: withLocaleDirective(params.messages, ctx.locale),
        },
        signal ? { signal } : undefined,
      );
      for await (const chunk of stream) {
        // The usage-bearing chunk arrives last and has no choices.
        if (chunk.usage) reported = fromUsage(chunk.usage);
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
      // that point is still real, and the caller decides what to keep. Either
      // way the tokens were spent upstream, so the call is still recorded.
      const cancelled = signal?.aborted === true;
      this.bill(ctx, reported ?? estimateFor(params.messages, content), startedAt, {
        ok: cancelled,
        error: cancelled ? 'cancelled by client' : err instanceof Error ? err.message : String(err),
        toolCallCount: partial.size,
      });
      if (cancelled) return { content, toolCalls: [], cancelled: true };
      throw this.upstreamError(err);
    }
    const toolCalls = [...partial.values()].filter((c) => c.name);
    this.bill(ctx, reported ?? estimateFor(params.messages, content), startedAt, {
      ok: true,
      toolCallCount: toolCalls.length,
    });
    return { content, toolCalls, cancelled: false };
  }

  private async create(
    ctx: AiCallContext,
    params: Omit<OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, 'model' | 'temperature'>,
  ) {
    const client = this.clientFor(ctx.config);
    const startedAt = Date.now();
    try {
      const completion = await client.chat.completions.create({
        model: ctx.config.model,
        temperature: ctx.config.temperature,
        ...params,
        messages: withLocaleDirective(params.messages, ctx.locale),
      });
      this.bill(
        ctx,
        completion.usage
          ? fromUsage(completion.usage)
          : estimateFor(params.messages, completion.choices[0]?.message?.content ?? ''),
        startedAt,
        { ok: true, toolCallCount: completion.choices[0]?.message?.tool_calls?.length ?? 0 },
      );
      return completion;
    } catch (err) {
      this.bill(ctx, estimateFor(params.messages, ''), startedAt, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw this.upstreamError(err);
    }
  }

  /**
   * Records one upstream call. Deliberately not awaited: token accounting is
   * observability, and a failed insert must never turn a good answer into an
   * error (AiUsageService.record swallows and warns, same as ActivityService).
   */
  private bill(
    ctx: AiCallContext,
    tokens: AiUsageTokens,
    startedAt: number,
    outcome: { ok: boolean; error?: string; toolCallCount?: number },
  ): void {
    const durationMs = Date.now() - startedAt;
    void this.usage.record({
      config: ctx.config,
      userId: ctx.userId,
      operation: ctx.operation,
      threadId: ctx.threadId,
      tokens,
      durationMs,
      ok: outcome.ok,
      error: outcome.error,
      toolCallCount: outcome.toolCallCount ?? 0,
    });
    // The measurement twin of the ai_usage row. ai_usage stays billing truth in
    // Postgres; this rides the JSONL stream and carries the trace id, so a model
    // or prompt change can be compared against the run before it without a SQL
    // join per experiment. Emitted from bill() because that is the one funnel
    // both create() and createStream() already pass through — including their
    // failure and cancellation paths, which are the calls worth measuring most.
    emitBacktest({
      ...(currentTrace() ?? { traceId: 'unscoped', source: 'cli' as const }),
      workspaceId: ctx.config.workspaceId,
      userId: ctx.userId,
      kind: 'ai.call',
      ts: new Date().toISOString(),
      durationMs,
      operation: ctx.operation,
      provider: ctx.config.provider,
      model: ctx.config.model,
      promptTokens: tokens.promptTokens,
      completionTokens: tokens.completionTokens,
      toolCallCount: outcome.toolCallCount ?? 0,
      ok: outcome.ok,
      estimated: tokens.estimated,
    });
  }

  /** Billable calls only — asking the user something is free, see FREE_TOOLS. */
  private budgetLeft(ctx: AiCallContext, trace: AssistantToolCall[]): number {
    return ctx.config.maxToolCalls - trace.filter((c) => !FREE_TOOLS.has(c.tool)).length;
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
