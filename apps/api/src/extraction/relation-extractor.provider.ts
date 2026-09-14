import type { ResolvedAiConfig } from '../ai/ai-config.service.js';

export interface ExtractionChunk {
  chunkId: string;
  text: string;
  headingPath: string[];
}

/** Inferred fact (plan.md §5 "inferred" class): always carries confidence + source span. */
export interface InferredFact {
  type: string;
  target: { key: string; type: string; name: string };
  confidence: number;
  sourceChunkId: string;
  snippet: string;
}

/**
 * Per-workspace extraction tuning (docs/features/12).
 *
 * Passed per call rather than held on the instance: ExtractorFactory caches
 * extractors by connection identity, and returns a process-wide singleton when
 * no provider profile is routed — neither could carry a per-workspace value.
 */
export interface ExtractionTuning {
  /** Relations scoring below this are discarded. */
  minConfidence: number;
  /** Only this many chunks of a page are sent to the model. */
  maxChunks: number;
}

/**
 * LLM relation extraction (plan.md §11 Phase 4). Implementations must only
 * emit types from the graph allowlist and confidence in [0, 1]; extraction
 * failures must throw — the caller treats them as non-fatal for indexing.
 */
/**
 * Who an extraction call is billed to (docs/features/12).
 *
 * Extraction runs in the worker, which has no request principal, so the owner
 * is the revision's author — `document_revisions.author_id`, a NOT NULL uuid
 * already loaded at the call site. Deliberately not a sentinel string like
 * 'worker': `ai_usage.user_id` is `@db.Uuid`, so a non-uuid fails the insert,
 * and `record` swallows failures — which is exactly how trigger-started
 * workflow spend became invisible (docs/features/20 §A).
 */
export interface ExtractionBilling {
  config: ResolvedAiConfig;
  userId: string;
}

export interface RelationExtractor {
  readonly enabled: boolean;
  extract(
    input: { documentTitle: string; chunks: ExtractionChunk[] } & ExtractionTuning & ExtractionBilling,
  ): Promise<InferredFact[]>;
}
