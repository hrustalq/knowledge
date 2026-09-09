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
 * LLM relation extraction (plan.md §11 Phase 4). Implementations must only
 * emit types from the graph allowlist and confidence in [0, 1]; extraction
 * failures must throw — the caller treats them as non-fatal for indexing.
 */
export interface RelationExtractor {
  readonly enabled: boolean;
  extract(input: { documentTitle: string; chunks: ExtractionChunk[] }): Promise<InferredFact[]>;
}
