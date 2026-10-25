import type { DocumentAclFilter } from '../common/document-acl.js';
import type { RevisionStamp, TemporalPoint } from '../graph/temporal.js';

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
  /**
   * Idempotent per revision: previous rows for the revision are dropped first.
   * `aclNodes` is the page's `restricted_by`, stamped on every row (#76).
   * `title` is the page's, matched beside each chunk's headings (#528).
   */
  indexRevisionChunks(
    workspaceId: string,
    revisionId: string,
    chunks: FulltextChunk[],
    opts: { live: boolean; aclNodes: string[]; title: string },
  ): Promise<void>;
  deleteRevision(revisionId: string): Promise<void>;
  /** Every row of a workspace, for its teardown (#479). */
  deleteWorkspace(workspaceId: string): Promise<void>;
  /**
   * Make one revision the document's live projection (#83) and demote every
   * other revision of the document; `null` demotes all. Mirrors
   * `GraphService.setLiveRevision`, and `search` must serve live rows only.
   */
  setLiveRevision(workspaceId: string, documentId: string, revisionId: string | null): Promise<void>;
  /** Rewrite the `aclNodes` stamp on every row of a page after its restrictions changed (#76). */
  restamp(workspaceId: string, documentId: string, aclNodes: string[]): Promise<void>;
  /** Mirror `GraphService.stampRevisions` (#81): each revision's valid-time interval and lineage. */
  stampRevisions(workspaceId: string, documentId: string, stamps: readonly RevisionStamp[]): Promise<void>;
  /**
   * Workspace predicate is mandatory (plan.md §6 security note). Live rows
   * only — or, with `at` (#81), the rows whose interval covers it — and only
   * pages `acl` admits (#76).
   */
  search(workspaceId: string, query: string, k: number, acl: DocumentAclFilter, at?: TemporalPoint): Promise<FulltextHit[]>;
}

export class NoopFulltextProvider implements FulltextProvider {
  readonly enabled = false;
  async indexRevisionChunks(): Promise<void> {}
  async deleteRevision(): Promise<void> {}
  async deleteWorkspace(): Promise<void> {}
  async setLiveRevision(): Promise<void> {}
  async restamp(): Promise<void> {}
  async stampRevisions(): Promise<void> {}
  async search(): Promise<FulltextHit[]> {
    return [];
  }
}
