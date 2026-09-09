import { Injectable, Logger } from '@nestjs/common';
import type { AgentTiebreak } from '../agents/agent-router.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AgentRouterService } from '../agents/agent-router.service.js';
import { AiConfigService } from './ai-config.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';

/**
 * The router's classifier (docs/features/20), API-side only.
 *
 * It runs on the *cheapest capable* profile rather than the router agent's own
 * routed model, because this call happens on the way to answering and its cost
 * is pure overhead. If the workspace has no profile that can emit JSON, there
 * is no classifier and the router falls back to its rules — which is the whole
 * reason the tiebreak is optional rather than a hard dependency.
 */
@Injectable()
export class AgentTiebreakService implements AgentTiebreak {
  private readonly logger = new Logger(AgentTiebreakService.name);

  constructor(
    private readonly registry: AgentRegistryService,
    private readonly router: AgentRouterService,
    private readonly aiConfig: AiConfigService,
    private readonly client: AssistantClient,
  ) {}

  async choose(input: {
    workspaceId: string;
    request: string;
    candidates: Array<{ key: string; description: string }>;
    locale: 'en' | 'ru';
    userId: string;
  }): Promise<{ agentKey: string; confidence: number; reason: string } | null> {
    const agent = await this.registry.resolve(input.workspaceId, 'router');
    if (!agent.enabled) return null;

    // Prefer the cheapest JSON-capable profile; fall back to whatever the
    // router agent itself resolved to when the workspace names no profiles.
    const cheapest = await this.router.cheapestCapable(input.workspaceId, ['json']);
    const config = cheapest
      ? await this.aiConfig.resolveFor(input.workspaceId, agent.purpose, cheapest)
      : agent.config;
    if (!config.enabled) return null;

    const raw = await this.client.chat(
      { config, userId: input.userId, operation: 'route', locale: input.locale },
      [
        { role: 'system', content: agent.instructions },
        {
          role: 'user',
          content:
            `Request:\n${input.request}\n\nCandidates:\n` +
            input.candidates.map((c) => `- ${c.key}: ${c.description}`).join('\n'),
        },
      ],
      { json: true },
    );

    const parsed = safeJson(raw);
    const agentKey = typeof parsed?.agentKey === 'string' ? parsed.agentKey : null;
    if (!agentKey) return null;
    const confidence = typeof parsed?.confidence === 'number' ? clamp(parsed.confidence) : 0.5;
    const reason = typeof parsed?.reason === 'string' ? parsed.reason.slice(0, 500) : 'Chosen by the classifier.';
    return { agentKey, confidence, reason };
  }
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** Fence-tolerant parse, matching AssistantService.parseJson's leniency. */
function safeJson(raw: string): Record<string, unknown> | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(stripped.slice(start, end + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    return null;
  }
}
