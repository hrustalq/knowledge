/**
 * Phase 5 optional BM25 layer (plan.md §11): pluggable full-text provider,
 * mirroring the embeddings/extractor pattern. 'none' keeps search vector-only
 * with zero external deps; 'opensearch' adds keyword recall + hybrid fusion.
 */
export const FULLTEXT_PROVIDER = 'FULLTEXT_PROVIDER';

export interface FulltextChunk {
  chunkId: string;
  documentId: string;
  revisionId: string;
  index: number;
  text: string;
  headingPath: string[];
}

export interface FulltextHit {
  chunkId: string;
  documentId: string;
  revisionId: string;
  text: string;
  headingPath: string[];
  /** Raw BM25 score (relative — only rank order is meaningful across engines). */
  score: number;
}

export interface FulltextProvider {
  readonly enabled: boolean;
  /** Idempotent per revision: previous rows for the revision are dropped first. */
  indexRevisionChunks(workspaceId: string, revisionId: string, chunks: FulltextChunk[]): Promise<void>;
  deleteRevision(revisionId: string): Promise<void>;
  /** Workspace predicate is mandatory (plan.md §6 security note). */
  search(workspaceId: string, query: string, k: number): Promise<FulltextHit[]>;
}

export class NoopFulltextProvider implements FulltextProvider {
  readonly enabled = false;
  async indexRevisionChunks(): Promise<void> {}
  async deleteRevision(): Promise<void> {}
  async search(): Promise<FulltextHit[]> {
    return [];
  }
}
