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
export interface RelationExtractor {
  readonly enabled: boolean;
  extract(
    input: { documentTitle: string; chunks: ExtractionChunk[] } & ExtractionTuning,
  ): Promise<InferredFact[]>;
}
