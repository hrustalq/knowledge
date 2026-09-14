import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { NoopExtractor } from './noop.provider.js';
import { OpenAICompatibleExtractor } from './openai-compatible.provider.js';
import type { ExtractionTuning, RelationExtractor } from './relation-extractor.provider.js';

/**
 * Builds the relation extractor for one workspace (docs/features/12).
 *
 * Extraction used to be a single instance wired from EXTRACTOR_* at module
 * construction, which meant every workspace shared one model and changing it
 * needed a worker restart. It is now resolved per job, exactly like the
 * assistant's own config: if the workspace routes 'extraction' at a provider
 * profile, that profile runs it; otherwise the EXTRACTOR_* env vars do, so an
 * install that never touches the settings page is unaffected.
 *
 * Instances are cached by the fields that shape a connection — a job stream
 * for one workspace must not rebuild an SDK client per document.
 */
@Injectable()
export class ExtractorFactory {
  private readonly cache = new Map<string, RelationExtractor>();
  private readonly envExtractor: RelationExtractor;
  private readonly noopExtractor: RelationExtractor = new NoopExtractor();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly agents: AgentRegistryService,
  ) {
    this.envExtractor =
      config.get('EXTRACTOR_PROVIDER', { infer: true }) === 'openai-compatible'
        ? new OpenAICompatibleExtractor(
            config.get('EXTRACTOR_BASE_URL', { infer: true }),
            config.get('EXTRACTOR_MODEL', { infer: true }),
            config.get('EXTRACTOR_API_KEY', { infer: true }),
          )
        : new NoopExtractor();
  }

  async forWorkspace(
    workspaceId: string,
  ): Promise<{ extractor: RelationExtractor; tuning: ExtractionTuning }> {
    // The `extractor` agent (docs/features/20) owns this call's routing, so an
    // admin can pin extraction at one profile or switch it off without touching
    // the workspace-wide 'extraction' route. Its instructions are deliberately
    // empty: OpenAICompatibleExtractor builds its own prompt around the closed
    // RELATION_EDGE_TYPES allowlist, and letting settings rewrite that would
    // invite edge types GraphService is required to refuse.
    const agent = await this.agents.resolve(workspaceId, 'extractor');
    const resolved = agent.config;

    // Tuning rides along with the extractor rather than inside it. It cannot
    // live on the instance: the cache below is keyed by connection identity so
    // one object serves every workspace sharing a profile, and envExtractor is
    // built once in the constructor. Resolving it here also means an admin's
    // change takes effect within the config TTL instead of at worker restart.
    const tuning: ExtractionTuning = {
      minConfidence: resolved.extractionMinConfidence,
      maxChunks: resolved.extractionMaxChunks,
    };

    // Switched off explicitly — do no extraction rather than quietly falling
    // back to the env extractor, which would ignore the admin's decision.
    if (!agent.enabled) return { extractor: this.noopExtractor, tuning };

    // No profile routed at extraction: keep the env-configured extractor,
    // which is a different provider setting from the assistant's and stays
    // independent of it.
    if (!resolved.providerId || !resolved.enabled) return { extractor: this.envExtractor, tuning };

    const key = `${resolved.providerId}|${resolved.baseUrl}|${resolved.model}|${resolved.apiKey}`;
    const hit = this.cache.get(key);
    if (hit) return { extractor: hit, tuning };

    const extractor = new OpenAICompatibleExtractor(resolved.baseUrl, resolved.model, resolved.apiKey);
    // Bounded: a workspace churning provider settings must not grow this map.
    if (this.cache.size >= 32) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, extractor);
    return { extractor, tuning };
  }
}
