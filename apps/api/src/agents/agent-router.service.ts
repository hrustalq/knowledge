import { Injectable, Logger } from '@nestjs/common';
import type { AgentCapability, AgentSurface, Locale } from '@knowledge/contracts';
import { AiProvidersService } from '../ai/ai-providers.service.js';
import { AgentRegistryService, type ResolvedAgent } from './agent-registry.service.js';
import { capabilitiesFor } from './model-capabilities.js';

/**
 * The LLM tiebreak, passed in by the caller rather than injected.
 *
 * It cannot be a DI token: the only implementation needs AssistantClient, which
 * lives in AssistantModule (API-only, and it pulls DocumentsModule, which the
 * worker cannot load). AgentCoreModule is imported *by* AiModule, so a provider
 * registered there would be invisible here. An argument makes the asymmetry
 * explicit at every call site instead of hiding it in module wiring.
 */
export interface AgentTiebreak {
  choose(input: {
    workspaceId: string;
    request: string;
    candidates: Array<{ key: string; description: string }>;
    locale: Locale;
    userId: string;
  }): Promise<{ agentKey: string; confidence: number; reason: string } | null>;
}

export interface RouteRequest {
  workspaceId: string;
  /** What the user asked, when there is a request to classify. */
  request?: string;
  /** Restrict candidates to agents that can run here. */
  surface?: AgentSurface;
  /** An explicit choice, which short-circuits everything. */
  agentKey?: string;
  locale?: Locale;
  userId?: string;
}

export interface RouteDecision {
  agentKey: string;
  providerId: string | null;
  providerName: string | null;
  model: string;
  /** 'explicit' | 'only-candidate' | 'rules' | 'model' | 'fallback' */
  via: string;
  reason: string;
  confidence: number;
  /** Agents considered but rejected, and why — this is what makes a routing bug diagnosable. */
  rejected: Array<{ agentKey: string; reason: string }>;
}

/** When nothing else decides, this is who answers. */
const DEFAULT_AGENT = 'researcher';

/**
 * Picks the agent and the model for a request (docs/features/20).
 *
 * Deterministic first, and the ordering is the whole design. An LLM that picks
 * the model is itself a call somebody had to pick a model for, so the choice of
 * *which* model runs the classifier can never itself be classified. The way out
 * is that capability, budget and enablement are facts, not judgements: they are
 * decided in code, and the model is only ever asked to break a tie between
 * candidates that already passed. With no tiebreak available — the worker, or a
 * workspace with no capable provider — the router stops at the rules and is
 * still correct, just less specific.
 */
@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly providers: AiProvidersService,
  ) {}

  /**
   * @param tiebreak Supplied by API callers that can afford a classifier call.
   *   Omitted in the worker, where the router stops at the rules.
   */
  async route(input: RouteRequest, tiebreak?: AgentTiebreak): Promise<RouteDecision> {
    const all = await this.registry.list(input.workspaceId);
    const rejected: RouteDecision['rejected'] = [];

    // 1. An explicit pick is a decision already made. Honour it without a
    //    single extra call — including its capability verdict, so the caller
    //    still learns the model cannot do the job.
    if (input.agentKey) {
      const picked = all.find((a) => a.key === input.agentKey);
      if (picked) return this.decide(picked, 'explicit', 'Explicitly requested.', 1, rejected);
    }

    // 2. Deterministic filter: enabled, runs on this surface, and has a model
    //    that can actually do what it needs.
    const candidates: ResolvedAgent[] = [];
    for (const agent of all) {
      if (agent.key === 'router') continue; // never routes to itself
      if (!agent.enabled) {
        rejected.push({ agentKey: agent.key, reason: 'disabled' });
        continue;
      }
      if (input.surface && !agent.surfaces.includes(input.surface)) {
        rejected.push({ agentKey: agent.key, reason: `does not run on the ${input.surface} surface` });
        continue;
      }
      if (!agent.config.enabled) {
        rejected.push({ agentKey: agent.key, reason: 'no provider configured' });
        continue;
      }
      if (agent.missing.length) {
        rejected.push({ agentKey: agent.key, reason: `model lacks ${agent.missing.join(', ')}` });
        continue;
      }
      candidates.push(agent);
    }

    if (candidates.length === 0) {
      const fallback = all.find((a) => a.key === DEFAULT_AGENT) ?? all[0];
      return this.decide(fallback, 'fallback', 'No agent passed the capability gate.', 0, rejected);
    }
    if (candidates.length === 1) {
      return this.decide(candidates[0], 'only-candidate', 'The only agent able to run this.', 1, rejected);
    }

    // 3. No request to classify, or no tiebreak available: rules only.
    if (!input.request?.trim() || !tiebreak) {
      const chosen = candidates.find((a) => a.key === DEFAULT_AGENT) ?? candidates[0];
      const why = tiebreak ? 'No request text to classify.' : 'No classifier available.';
      return this.decide(chosen, 'rules', `${why} Fell back to ${chosen.name}.`, 0.5, rejected);
    }

    // 4. Tie broken by a model, over candidates that already passed the gate.
    try {
      const verdict = await tiebreak.choose({
        workspaceId: input.workspaceId,
        request: input.request.slice(0, 4_000),
        candidates: candidates.map((a) => ({ key: a.key, description: a.description })),
        locale: input.locale ?? 'en',
        userId: input.userId ?? 'router',
      });
      const chosen = verdict && candidates.find((a) => a.key === verdict.agentKey);
      if (chosen && verdict) {
        return this.decide(chosen, 'model', verdict.reason, verdict.confidence, rejected);
      }
    } catch (error) {
      // A classifier that is down must not take the whole request with it.
      this.logger.warn(`Agent tiebreak failed, falling back to rules: ${String(error)}`);
    }
    const chosen = candidates.find((a) => a.key === DEFAULT_AGENT) ?? candidates[0];
    return this.decide(chosen, 'rules', 'Classifier gave no usable answer.', 0.4, rejected);
  }

  /** The cheapest capable profile, used for the classifier's own call. */
  async cheapestCapable(workspaceId: string, required: AgentCapability[]): Promise<string | null> {
    const profiles = await this.providers.enabledProviders(workspaceId);
    const capable = profiles.filter((p) => {
      const has = capabilitiesFor(p.model, p.capabilities);
      return required.every((c) => has.has(c));
    });
    if (capable.length === 0) return null;
    // Price is optional metadata, so a profile that declares none sorts last
    // rather than winning by default.
    const priced = capable
      .map((p) => ({ id: p.id, price: p.pricePromptPerMTok === null ? Infinity : Number(p.pricePromptPerMTok) }))
      .sort((a, b) => a.price - b.price);
    return priced[0].id;
  }

  private decide(
    agent: ResolvedAgent,
    via: string,
    reason: string,
    confidence: number,
    rejected: RouteDecision['rejected'],
  ): RouteDecision {
    return {
      agentKey: agent.key,
      providerId: agent.config.providerId,
      providerName: agent.config.providerName,
      model: agent.config.model,
      via,
      reason,
      confidence,
      rejected,
    };
  }
}
