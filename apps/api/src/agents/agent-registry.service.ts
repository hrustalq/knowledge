import { Injectable } from '@nestjs/common';
import type { AiAgent } from '@prisma/client';
import type { AgentCapability, AgentSurface, AiPurpose } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfigService, type ResolvedAiConfig } from '../ai/ai-config.service.js';
import { AiProvidersService } from '../ai/ai-providers.service.js';
import { BUILT_IN_AGENT_DEFAULTS, type BuiltInAgentDefault } from './built-in-agents.js';
import { missingCapabilities } from './model-capabilities.js';

/** One agent, fully resolved: code default ⊕ the workspace's override row ⊕ its model. */
export interface ResolvedAgent {
  key: string;
  builtIn: boolean;
  name: string;
  description: string;
  instructions: string;
  tools: string[];
  skillIds: string[];
  purpose: AiPurpose;
  surfaces: AgentSurface[];
  requires: AgentCapability[];
  /** The agent itself is switched on. Distinct from `config.enabled`, which is the provider. */
  enabled: boolean;
  /** Provider profile + harness budget, with this agent's overrides folded in. */
  config: ResolvedAiConfig;
  /**
   * Capabilities the agent needs that the resolved model does not offer.
   * Empty means it is safe to call. Callers must check this rather than assume:
   * the whole point of the gate is that a blind model asked to read an image
   * answers confidently instead of failing.
   */
  missing: AgentCapability[];
}

/** How long the override rows are reused before PG is consulted again. */
const CACHE_TTL_MS = 30_000;

/**
 * Resolves an agent for a workspace (docs/features/20).
 *
 * The fold is one line of policy: a built-in's code default supplies every
 * field, an `ai_agents` row overrides the fields it sets, and null means
 * inherit. An empty table therefore reproduces the behaviour every call site
 * had before agents existed — which is the property the first phase is
 * verified against.
 *
 * Provider resolution DELEGATES to AiConfigService rather than reimplementing
 * it, so the feature-12 chain grows one link at the front and keeps all its
 * existing behaviour: agent pin -> purpose route -> inline config -> env, still
 * first-hit-wins, and a disabled or deleted profile still falls through instead
 * of failing the call.
 *
 * Only the override rows are cached (one query per workspace, like the skills
 * roster). `resolveFor` is deliberately called fresh every time, exactly as the
 * call sites called it before, so this introduces no second staleness window on
 * top of AiConfigService's own.
 */
@Injectable()
export class AgentRegistryService {
  private readonly cache = new Map<string, { at: number; rows: Map<string, AiAgent> }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfigService,
    private readonly providers: AiProvidersService,
  ) {}

  /** Drop the cached override rows for a workspace. Called from every agent write. */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  private async rowsFor(workspaceId: string): Promise<Map<string, AiAgent>> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.rows;
    const found = await this.prisma.aiAgent.findMany({ where: { workspaceId } });
    const rows = new Map(found.map((row) => [row.key, row]));
    this.cache.set(workspaceId, { at: Date.now(), rows });
    return rows;
  }

  /**
   * Resolve one agent. Throws for an unknown key rather than falling back to a
   * default agent: a caller asking for `reviewer` and silently getting the chat
   * agent would be far harder to notice than an error.
   */
  async resolve(workspaceId: string, key: string, pinnedProviderId?: string | null): Promise<ResolvedAgent> {
    const rows = await this.rowsFor(workspaceId);
    const row = rows.get(key) ?? null;
    const base = BUILT_IN_AGENT_DEFAULTS[key as keyof typeof BUILT_IN_AGENT_DEFAULTS] ?? null;
    if (!base && !row) throw new Error(`Unknown agent "${key}"`);
    return this.merge(workspaceId, key, base, row, pinnedProviderId);
  }

  /** Every agent this workspace has: the built-in roster ⊕ overrides, plus custom rows. */
  async list(workspaceId: string): Promise<ResolvedAgent[]> {
    const rows = await this.rowsFor(workspaceId);
    const builtIns = Object.values(BUILT_IN_AGENT_DEFAULTS);
    const custom = [...rows.values()].filter((row) => !(row.key in BUILT_IN_AGENT_DEFAULTS));
    return Promise.all([
      ...builtIns.map((base) => this.merge(workspaceId, base.key, base, rows.get(base.key) ?? null)),
      ...custom.map((row) => this.merge(workspaceId, row.key, null, row)),
    ]);
  }

  private async merge(
    workspaceId: string,
    key: string,
    base: BuiltInAgentDefault | null,
    row: AiAgent | null,
    /** A thread's own pin, which outranks the agent's — the member chose it for this conversation. */
    pinnedProviderId?: string | null,
  ): Promise<ResolvedAgent> {
    const purpose: AiPurpose = base?.purpose ?? 'chat';
    const config = await this.aiConfig.resolveFor(
      workspaceId,
      purpose,
      pinnedProviderId ?? row?.providerId ?? undefined,
    );

    // The agent's harness overrides sit on top of whatever profile served it —
    // an agent that needs a longer leash than the workspace default says so
    // once, rather than every call site remembering to raise the budget.
    // An admin's declaration on the profile beats the model table (see
    // model-capabilities.ts). Only a named profile can carry one; the inline
    // ai_settings config and the env fall back to the table. Read from the
    // cached roster rather than a fresh query — this runs on every chat turn.
    const providerCapabilities = config.providerId
      ? ((await this.providers.enabledProviders(workspaceId)).find((p) => p.id === config.providerId)
          ?.capabilities ?? null)
      : null;

    const tuned: ResolvedAiConfig = {
      ...config,
      temperature: row?.temperature ?? config.temperature,
      maxToolCalls: row?.maxToolCalls ?? config.maxToolCalls,
      timeoutMs: row?.timeoutMs ?? config.timeoutMs,
    };

    const requires = base?.requires ?? [];
    return {
      key,
      builtIn: base !== null,
      name: row?.name ?? base?.name ?? key,
      description: row?.description ?? base?.description ?? '',
      instructions: row?.instructions ?? base?.instructions ?? '',
      tools: readStrings(row?.tools) ?? base?.tools ?? [],
      skillIds: readStrings(row?.skillIds) ?? base?.skillIds ?? [],
      purpose,
      surfaces: base?.surfaces ?? ['interactive'],
      requires,
      enabled: row?.enabled ?? true,
      config: tuned,
      missing: tuned.enabled ? missingCapabilities(requires, tuned.model, providerCapabilities) : [],
    };
  }
}

/**
 * Json columns are read defensively (the AiSkillsService.readTriggers
 * precedent): the column is `Json?`, so anything could be in there, and a bad
 * value must degrade to "inherit the default" rather than crash a turn.
 */
function readStrings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter((v): v is string => typeof v === 'string');
  return strings.length === value.length ? strings : null;
}
