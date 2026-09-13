import type { ChunkSummary, DocumentSummary, RevisionInfo, RevisionStatus } from '@knowledge/contracts/core';
import type { FactExtractor } from '@knowledge/contracts/graph';
import type { DeleteReviewCommentResponse, ReviewComment, ReviewThread, SemanticDiff, StructuralDiff } from '@knowledge/contracts/reviews';

// rich editor. Two-step by design (presign → confirm), mirroring the revision
// upload flow: the API never streams file bodies, and a row only becomes
// `ready` once the object is confirmed in object storage.

/** File types the editor accepts. SVG is deliberately absent — an uploaded
 *  SVG is executable markup, and the whiteboard/mermaid nodes cover vector art. */
export const ATTACHMENT_CONTENT_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/json',
  'application/zip',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export type AttachmentStatus = 'pending' | 'ready';

export interface AttachmentSummary {
  attachmentId: string;
  documentId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  status: AttachmentStatus;
  uploadedBy: string;
  createdAt: string;
  /** Stable API path the stored markdown links to (no token; the client adds one when needed). */
  url: string;
}

export interface CreateAttachmentResponse {
  attachment: AttachmentSummary;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

// POST /v1/documents/:id/attachments/:attachmentId/complete
export interface CompleteAttachmentResponse {
  attachment: AttachmentSummary;
}

// GET /v1/documents/:id/attachments
export interface ListAttachmentsResponse {
  attachments: AttachmentSummary[];
}

export interface CreateUploadResponse {
  documentId: string;
  revisionId: string;
  upload: { method: 'PUT'; url: string; objectKey: string };
}

// POST /v1/documents/:id/revisions/:revisionId/finalize
export interface FinalizeRevisionResponse {
  revisionId: string;
  status: RevisionStatus;
  ingestionJobId: string | null;
  deduplicated: boolean;
}

// GET /v1/documents/:id
export interface DocumentDetailResponse {
  document: DocumentSummary;
  revision: RevisionInfo;
  chunks: ChunkSummary[];
}

// GET /v1/documents
export interface ListDocumentsResponse {
  items: DocumentSummary[];
  nextCursor: string | null;
}

// POST /v1/search
export interface SearchRequest {
  workspaceId: string;
  query: string;
  /** 'hybrid' fuses vector + BM25 (when a fulltext provider is configured); 'keyword' is BM25-only. */
  mode?: 'hybrid' | 'semantic' | 'keyword';
  limit?: number;
  /**
   * Phase 4 hybrid expansion: walk relation edges out from the vector hits.
   * depth = entity hops (default 1, max 3); relationTypes filters edge types.
   */
  expandGraph?: { depth?: number; relationTypes?: string[] };
  /**
   * Feature 02 metadata filters, applied post-ranking. categories/projectIds
   * resolve against PG; tags resolve against the graph (frontmatter `tags:`
   * become TAGGED_WITH edges to `tag:<name>` entities). Tags match with OR
   * semantics: a document passes if it carries any of the listed tags.
   */
  filters?: { categories?: DocumentCategory[]; projectIds?: string[]; tags?: string[] };
}
export interface SearchResult {
  documentId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  snippet: string;
  score: number;
  /** Entities related to the result's document (present when expandGraph is used). */
  entities?: EntityRef[];
}
export interface SearchResponse {
  results: SearchResult[];
  /** Documents reached only via graph expansion (not in the vector hits). */
  related?: RelatedDocumentResult[];
}
/** A document discovered by graph expansion, with the connecting evidence. */
export interface RelatedDocumentResult {
  documentId: string;
  title: string;
  /** Entity hops from the nearest vector hit (1 = shares an entity with a hit). */
  distance: number;
  /** Edges that connect this document into the hit set. */
  via: Array<{ entityKey: string; relationType: string; confidence: number }>;
}

// ---------------------------------------------------------------------------
// Phase 2 — revision DAG, branches, compare, deterministic relations
// ---------------------------------------------------------------------------

export interface BranchInfo {
  branchId: string;
  documentId: string;
  name: string;
  headRevisionId: string | null;
  protected: boolean;
  createdAt: string;
}

export interface CreateBranchResponse {
  branch: BranchInfo;
}

// GET /v1/documents/:id/branches
export interface ListBranchesResponse {
  branches: BranchInfo[];
}

/** RevisionInfo + DAG parentage (revision_parents) and owning branch. */
export interface RevisionNode extends RevisionInfo {
  branch: string | null;
  parentRevisionIds: string[];
}

// GET /v1/documents/:id/revisions
export interface ListRevisionsResponse {
  documentId: string;
  revisions: RevisionNode[];
}

// GET /v1/documents/:id/compare?from&to&mode=direct|merge-base
export type CompareMode = 'direct' | 'merge-base';

export interface DiffLine {
  kind: 'context' | 'added' | 'deleted';
  old?: number;
  new?: number;
  text: string;
}
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
export interface CompareRevisionRef {
  revisionId: string;
  revisionNumber: number;
  branch: string | null;
  contentHash: string | null;
}
export interface CompareResponse {
  documentId: string;
  from: CompareRevisionRef;
  to: CompareRevisionRef;
  comparisonMode: CompareMode;
  /** Present in merge-base mode; the nearest common ancestor actually diffed against. */
  mergeBaseRevisionId: string | null;
  summary: { additions: number; deletions: number };
  hunks: DiffHunk[];
  /** Path-level structural diff (JSON/YAML content or markdown frontmatter); null when not applicable. */
  structural?: StructuralDiff | null;
  /** Graph-projection diff between the two revisions; null when neither side is indexed. */
  semantic?: SemanticDiff | null;
}

/**
 * Deterministic/explicit relation target (plan.md §5 fact classes).
 * `key` is a stable entity key such as "service:identity".
 */
export interface RelationTarget {
  type: string;
  key: string;
  name?: string;
}
export interface RelationInput {
  /** Edge type, e.g. DESCRIBES, DEPENDS_ON, IMPLEMENTS, RELATED_TO. */
  type: string;
  target: RelationTarget;
}

export interface EntityRef {
  key: string;
  type: string;
  name: string;
}
export interface RelationWithProvenance {
  type: string;
  from: string;
  to: EntityRef;
  provenance: {
    revisionId: string;
    extractor: FactExtractor;
    confidence: number;
    /** Present on inferred facts: the chunk the relation was extracted from. */
    sourceChunkId?: string;
    /** Present on inferred facts: excerpt supporting the relation. */
    snippet?: string;
  };
}

// GET /v1/documents/:id/relations
export interface ListDocumentRelationsResponse {
  documentId: string;
  relations: RelationWithProvenance[];
}

// ---------------------------------------------------------------------------
// Phase 3 — merge requests, structural & semantic diff, optimistic concurrency
// ---------------------------------------------------------------------------
// Same discussion model as merge request review, attached to the document. An
// unanchored thread is a comment on the page as a whole (the list under the
// content); a `text` anchor pins it to a passage, the way a PDF annotation
// pins to a quote rather than to a page coordinate.

export type DocumentComment = ReviewComment;

export interface DocumentThread extends ReviewThread {
  documentId: string;
}

// GET /v1/documents/:id/threads
export interface ListDocumentThreadsResponse {
  documentId: string;
  threads: DocumentThread[];
}




// DELETE /v1/documents/:id/threads/:threadId/comments/:commentId
export interface DeleteDocumentCommentResponse extends DeleteReviewCommentResponse {
  thread: DocumentThread | null;
}



// ---------------------------------------------------------------------------
// Phase 4 — inference, confidence-classed facts, entity traversal
// document graph view, activity feed, live events, AI assistant.
// ---------------------------------------------------------------------------

/** Feature 07: allowed document categories (kept as a const so DTOs and UI share one list). */
export const DOCUMENT_CATEGORIES = [
  'process',
  'use-case',
  'contract',
  'erd',
  'architecture',
  'guide',
  'reference',
  'other',
] as const;
export type DocumentCategory = (typeof DOCUMENT_CATEGORIES)[number];

// GET /v1/documents/:id/content (feature 01)
export interface DocumentContentResponse {
  documentId: string;
  revisionId: string;
  contentType: string;
  frontmatter: Record<string, unknown> | null;
  markdown: string;
}


// GET /v1/documents/tree?workspaceId=&projectId= (feature 08 + projects)
export interface DocumentTreeNode extends DocumentSummary {
  /**
   * Loaded children. Empty is ambiguous on its own — a leaf and an unexpanded
   * branch both have none — which is what `childCount` is for.
   */
  children: DocumentTreeNode[];
  /**
   * How many children this node has, whether or not they were loaded. The
   * disclosure chevron reads this, so a lazily-loaded tree can draw a correct
   * row before it knows what is under it.
   */
  childCount: number;
}
export interface DocumentTreeResponse {
  workspaceId: string;
  /** null when the tree spans the whole workspace (no projectId filter). */
  projectId: string | null;
  /** The node whose children these are; null for the top level. */
  parentId: string | null;
  roots: DocumentTreeNode[];
}

// GET /v1/documents/:id/ancestors
/**
 * The chain from the top of the tree down to (but not including) a document.
 *
 * A lazily-loaded tree does not contain a page until someone has expanded their
 * way to it, so "where does this page live" can no longer be answered by
 * walking the client's copy. Breadcrumbs and the sidebar's active-trail
 * expansion both ask this instead.
 */
export interface DocumentAncestorsResponse {
  documentId: string;
  /** Root first, nearest parent last. Empty when the document is a root. */
  ancestors: DocumentSummary[];
}

// GET /v1/documents/:id/graph?depth= (feature 06)
export interface DocumentGraphNode {
  /** documentId for documents, entity key for entities. */
  id: string;
  kind: 'document' | 'entity';
  label: string;
  category?: DocumentCategory | string;
  entityType?: string;
  /** Entity hops from the root document (root = 0). */
  distance: number;
}
export interface DocumentGraphEdge {
  /** Document node id (edges always point Document → Entity). */
  from: string;
  to: string;
  type: string;
  extractor: FactExtractor | string;
  confidence: number;
}
export interface DocumentGraphResponse {
  documentId: string;
  depth: number;
  nodes: DocumentGraphNode[];
  edges: DocumentGraphEdge[];
}

// GET /v1/documents/graph?workspaceId=&projectId=
/**
 * The whole workspace (or project) projected as one graph, for the pages
 * landing. Same node/edge vocabulary as the per-document neighbourhood, minus
 * `distance` — there is no root here — plus the two facts a workspace-scale
 * renderer needs and a neighbourhood does not: `degree`, because node size is
 * how a reader finds the hubs, and `status`, because the lifecycle dot has to
 * survive the trip out of the tree.
 */
export interface WorkspaceGraphNode {
  /** documentId for documents, entity key for entities. */
  id: string;
  kind: 'document' | 'entity';
  label: string;
  category?: DocumentCategory | string;
  entityType?: string;
  /** Documents only: head-revision status, for the lifecycle dot. */
  status?: RevisionStatus | null;
  /** Incident edge count, after filtering. */
  degree: number;
}
export interface WorkspaceGraphResponse {
  workspaceId: string;
  /** null when the graph spans the whole workspace (no projectId filter). */
  projectId: string | null;
  nodes: WorkspaceGraphNode[];
  edges: DocumentGraphEdge[];
  /** True when the workspace holds more edges than the render cap allows. */
  truncated: boolean;
}

// GET /v1/activity?workspaceId=&documentId=&limit=&cursor= (feature 10)
export interface ActivityEntry {
  id: string;
  workspaceId: string;
  actor: string;
  /** e.g. 'document.created', 'revision.finalized', 'merge-request.merged'. */
  action: string;
  documentId: string | null;
  documentTitle: string | null;
  /**
   * The project the action happened in, denormalized from the page it touched
   * so a project feed is one indexed read. Null for workspace-level rows, and
   * for history predating the column that the backfill could not attribute.
   */
  projectId: string | null;
  subjectId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface ListActivityResponse {
  workspaceId: string;
  entries: ActivityEntry[];
  nextCursor: string | null;
}

// ---------------------------------------------------------------------------
// Activity kinds — the four things a person does to a knowledge base.
