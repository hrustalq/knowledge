import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DECISION_DEFAULT_MODEL, type AiUsageOperation, type DecisionSite } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { AiConfigService, type ResolvedAiConfig } from '../ai/ai-config.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { t } from '../i18n/t.js';
import { ProviderAccountError } from './assistant.client.js';

/** gen-api's synchronous endpoint for TypeSafe Jev (docs/features/67). */
export const JEV_URL = 'https://api.gen-api.ru/api/v1/networks/jev';

/** A profile model that already names a Jev release; anything else asks DECISION_DEFAULT_MODEL. */
export const isJevModel = (model: string) => /^jev[-.]/.test(model);

/** Waits before each retry of a 429 / 529. TypeSafe publishes no rate limits, only "retry with backoff". */
const RETRY_DELAYS_MS = [1_000, 3_000];

/** A yes/no question: Jev answers with the probability that `true` holds. */
export interface NoulQuestion {
  instructions: string;
  criteria: { true: string; false: string };
}

/** A workspace's decision route: the config to call with and the threshold per call site. */
export interface DecisionRoute {
  config: ResolvedAiConfig;
  thresholds: Record<DecisionSite, number>;
}

export interface DecisionCall {
  route: DecisionRoute;
  userId: string;
  operation: AiUsageOperation;
  threadId?: string;
}

/**
 * The decision model (#530): TypeSafe Jev through gen-api, a typed yes/no in
 * place of a chat call that parses its own JSON. Not an `AiProviderKind`
 * behind `AssistantClient` — Jev does not speak the chat protocol.
 *
 * A decision is a pre-filter, never a verdict: a call site asks only when
 * `routeFor` returns a route, and with none it does exactly what it did
 * before #530. Each call writes one `ai_usage` row under the call site's
 * operation, with the model the response says served it.
 */
@Injectable()
export class DecisionClient {
  private readonly logger = new Logger(DecisionClient.name);

  constructor(
    private readonly aiConfig: AiConfigService,
    private readonly usage: AiUsageService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * The workspace's decision route, or null: off for the deployment
   * (DECISION_PROVIDER=none), no profile routed to `decision`, or a profile
   * that is not gen-api. Never the inline config — that is the chat model,
   * and a decision route is something an admin turns on.
   */
  async routeFor(workspaceId: string): Promise<DecisionRoute | null> {
    if (this.config.get('DECISION_PROVIDER', { infer: true }) === 'none') return null;
    const [config, settings] = await Promise.all([
      this.aiConfig.resolveFor(workspaceId, 'decision'),
      this.aiConfig.decisionSettings(workspaceId),
    ]);
    if (!config.providerId || config.provider !== 'gen-api' || !config.apiKey) return null;
    const thresholds = {
      arbiter: settings.thresholds.arbiter.effective,
      citation: settings.thresholds.citation.effective,
      harvest: settings.thresholds.harvest.effective,
    };
    // A gen-api chat profile routed here keeps its key but not its model, nor
    // the prices an admin set for that model.
    if (isJevModel(config.model)) return { config, thresholds };
    return {
      config: { ...config, model: DECISION_DEFAULT_MODEL, pricePromptPerMTok: null, priceCompletionPerMTok: null },
      thresholds,
    };
  }

  /**
   * One `noul` question about `state`: the probability that the statement is
   * true. `state` must be an object (gen-api refuses a string), and any page or
   * chat text in it must already be `wrapUntrusted` — the caller knows which.
   */
  async noul(call: DecisionCall, state: Record<string, unknown>, question: NoulQuestion): Promise<number> {
    const { config } = call.route;
    const body = JSON.stringify({ is_sync: true, model: config.model, state, questions: { answer: { type: 'noul', ...question } } });
    const startedAt = Date.now();
    let promptTokens = 0;
    let served = config.model;
    let costUsdMicros: number | null = null;
    try {
      const json = await this.post(config, body);
      const res = (json as { response?: JevResponse }).response;
      const p = res?.answers?.answer?.noul;
      if (typeof p !== 'number' || !(p >= 0 && p <= 1)) throw new Error('decision model returned no probability');
      promptTokens = res?.usage?.input_tokens ?? 0;
      served = res?.model ?? served;
      costUsdMicros =
        typeof res?.usage?.cost === 'number'
          ? Math.round(res.usage.cost * 1_000_000)
          : this.aiConfig.estimateCostMicros(config, promptTokens, 0);
      this.bill(call, served, promptTokens, costUsdMicros, startedAt, true);
      return p;
    } catch (err) {
      this.bill(call, served, promptTokens, costUsdMicros, startedAt, false, err instanceof Error ? err.message : String(err));
      throw this.upstreamError(err);
    }
  }

  private async post(config: ResolvedAiConfig, body: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(JEV_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${config.apiKey}` },
        body,
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if ((res.status === 429 || res.status === 529) && attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        continue;
      }
      if (!res.ok) throw new DecisionHttpError(res.status, (await res.text()).slice(0, 300));
      return res.json();
    }
  }

  private bill(
    call: DecisionCall,
    model: string,
    promptTokens: number,
    costUsdMicros: number | null,
    startedAt: number,
    ok: boolean,
    error?: string,
  ): void {
    void this.usage.record({
      config: { ...call.route.config, model },
      userId: call.userId,
      operation: call.operation,
      threadId: call.threadId,
      tokens: { promptTokens, completionTokens: 0, totalTokens: promptTokens, estimated: promptTokens === 0 },
      costUsdMicros,
      durationMs: Date.now() - startedAt,
      ok,
      error,
    });
  }

  private upstreamError(err: unknown): ServiceUnavailableException {
    if (err instanceof DecisionHttpError) {
      this.logger.warn(`Decision upstream ${err.status}: ${err.message}`);
      if (err.status === 402) return new ProviderAccountError(t('error.assistant.upstreamNoCredit'));
      if (err.status === 401 || err.status === 403) {
        return new ProviderAccountError(t('error.assistant.upstreamAuth', { status: err.status }));
      }
      return new ServiceUnavailableException(t('error.assistant.upstreamStatus', { status: err.status }));
    }
    this.logger.warn(`Decision request failed: ${err instanceof Error ? err.message : String(err)}`);
    return new ServiceUnavailableException(t('error.assistant.unreachable'));
  }
}

/** The part of gen-api's synchronous `jev` response this reads. */
interface JevResponse {
  model?: string;
  answers?: { answer?: { noul?: number } };
  usage?: { input_tokens?: number; cost?: number };
}

class DecisionHttpError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(body);
  }
}
