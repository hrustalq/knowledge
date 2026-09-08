// Shared API contract types for the Dynamic Knowledge Platform.
// Plain types + dependency-free error-contract helpers — no runtime deps, no server imports.

export type RevisionStatus = 'draft' | 'finalized' | 'indexing' | 'indexed' | 'failed';
export type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DocumentSummary {
  documentId: string;
  workspaceId: string;
  /** Owning project (Workspace > Project > Document). Always set. */
  projectId: string;
  title: string;
  defaultBranch: string;
  /** Feature 07 categorization. */
  category: DocumentCategory;
  /** Feature 08 nesting: parent document id, null for roots. */
  parentId: string | null;
  headRevisionId: string | null;
  headRevisionStatus: RevisionStatus | null;
  createdAt: string;
}

export interface RevisionInfo {
  revisionId: string;
  documentId: string;
  revisionNumber: number;
  contentHash: string | null;
  contentType: string;
  status: RevisionStatus;
  message: string | null;
  createdAt: string;
  finalizedAt: string | null;
}

export interface ChunkSummary {
  chunkId: string;
  headingPath: string[];
  snippet: string;
}

// POST /v1/documents
export interface CreateDocumentRequest {
  workspaceId: string;
  /** Owning project; must belong to `workspaceId`. */
  projectId: string;
  title: string;
  content?: { mode: 'inline'; format: string; text: string };
  /** Explicit relations (plan.md §5 "explicit" fact class) written as graph edges with provenance. */
  relations?: RelationInput[];
  /** Feature 07: defaults to 'other'. */
  category?: DocumentCategory;
  /** Feature 08: create nested under this document. */
  parentId?: string;
}
export interface CreateDocumentResponse {
  documentId: string;
  revisionId: string;
  branch: string;
  status: RevisionStatus;
}

// ---------------------------------------------------------------- attachments
// Confluence-style page attachments: images, PDFs and files embedded in the
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
export type AttachmentContentType = (typeof ATTACHMENT_CONTENT_TYPES)[number];

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

// POST /v1/documents/:id/attachments
export interface CreateAttachmentRequest {
  filename: string;
  contentType: string;
  sizeBytes?: number;
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

// POST /v1/documents/:id/uploads
export interface CreateUploadRequest {
  revisionId?: string;
  contentType: string;
  filename: string;
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

// POST /v1/documents/:id/branches
export interface CreateBranchRequest {
  name: string;
  /** Defaults to the current head of the document's default branch. */
  fromRevisionId?: string;
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

/** Path-level structural diff (plan.md §8): JSON/YAML content, or markdown frontmatter. */
export interface StructuralChange {
  /** Dotted path, e.g. "metadata.tags[0]". Empty string is the document root. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}
export interface StructuralDiff {
  /** What was diffed: the parsed content body (JSON/YAML) or markdown frontmatter. */
  source: 'content' | 'frontmatter';
  changes: StructuralChange[];
  summary: { added: number; removed: number; changed: number };
}

/** Semantic (graph-projection) diff between two revisions (plan.md §8). */
export interface SemanticRelationChange {
  type: string;
  targetKey: string;
  extractor: string;
  confidence: number;
}
export interface SemanticDiff {
  entities: { added: string[]; removed: string[] };
  relations: { added: SemanticRelationChange[]; removed: SemanticRelationChange[] };
  /** 1 - cosine(mean chunk embedding); null when either side has no indexed chunks. */
  embeddingShift: { score: number; meaningful: boolean } | null;
}

export type MergeRequestStatus = 'open' | 'merged' | 'closed';
export type MergeStrategy = 'merge-commit' | 'squash';

export interface MergeRequestInfo {
  mergeRequestId: string;
  documentId: string;
  title: string;
  description: string | null;
  sourceBranch: string;
  targetBranch: string;
  sourceHeadRevisionId: string | null;
  targetHeadRevisionId: string | null;
  /**
   * Nearest common ancestor of the two heads. Computed only on detail reads
   * and mutation responses; always null in list responses (avoids a graph
   * BFS per row).
   */
  mergeBaseRevisionId: string | null;
  status: MergeRequestStatus;
  /** Draft merge requests cannot be merged until the flag is cleared. */
  isDraft: boolean;
  /** Zeros-UUID stub when created without a principal (AUTH_MODE=none / MCP). */
  authorId: string;
  /** Single assignee (GitLab-style; advisory like reviewers). */
  assigneeId: string | null;
  approvedBy: string[];
  /** Assigned reviewer user ids (advisory — merging is gated by approval count, not reviewers). */
  reviewers: string[];
  /** Review-thread counts (computed on every read). */
  threadStats: { total: number; unresolved: number };
  strategy: MergeStrategy | null;
  mergedRevisionId: string | null;
  createdAt: string;
  mergedAt: string | null;
  closedAt: string | null;
}

// POST /v1/documents/:id/merge-requests
export interface CreateMergeRequestRequest {
  sourceBranch: string;
  /** Defaults to the document's default branch. */
  targetBranch?: string;
  title: string;
  description?: string;
}
export interface CreateMergeRequestResponse {
  mergeRequest: MergeRequestInfo;
}

// GET /v1/documents/:id/merge-requests
export interface ListMergeRequestsResponse {
  documentId: string;
  mergeRequests: MergeRequestInfo[];
}

// GET /v1/merge-requests/:id/diff
export interface MergeRequestDiffResponse {
  mergeRequest: MergeRequestInfo;
  /** merge-base comparison targetHead...sourceHead, with structural + semantic sections. */
  compare: CompareResponse;
}

// POST /v1/merge-requests/:id/merge
export interface MergeMergeRequestRequest {
  strategy?: MergeStrategy;
}
export interface MergeMergeRequestResponse {
  mergeRequest: MergeRequestInfo;
  mergedRevision: RevisionInfo | null;
}

/** 409 error envelope for If-Match / merge conflicts (plan.md §7): details always carries a comparison link. */
export interface RevisionConflictResponse extends ApiErrorPayload {
  code: 'CONFLICT';
  details: {
    currentHeadRevisionId: string | null;
    comparisonUrl: string | null;
  };
}

// GET /v1/merge-requests?workspaceId=…  (maps onto MCP knowledge_list_merge_requests)
export interface ListWorkspaceMergeRequestsRequest {
  workspaceId: string;
  status?: MergeRequestStatus;
  authorId?: string;
  /** Only merge requests with this user as the single assignee. */
  assigneeId?: string;
  /** Only merge requests with this user assigned as reviewer. */
  reviewerId?: string;
  documentId?: string;
  /** Case-insensitive substring match on the source branch name. */
  sourceBranch?: string;
  /** Case-insensitive substring match on the target branch name. */
  targetBranch?: string;
  /** Case-insensitive title substring match. */
  search?: string;
  cursor?: string;
  limit?: number;
}
export interface ListWorkspaceMergeRequestsResponse {
  workspaceId: string;
  mergeRequests: MergeRequestInfo[];
  nextCursor: string | null;
  /** Per-status totals for the same filters (status filter itself excluded) — drives the tab badges. */
  counts: { open: number; merged: number; closed: number };
}

// PATCH /v1/merge-requests/:id (open MRs only)
export interface UpdateMergeRequestRequest {
  title?: string;
  description?: string;
  isDraft?: boolean;
  /** Workspace member to assign; null clears the assignee. */
  assigneeId?: string | null;
}

// PUT /v1/merge-requests/:id/reviewers (replace-set semantics)
export interface SetMergeRequestReviewersRequest {
  reviewerIds: string[];
}

/**
 * 409 `details` vocabulary for merge gating (see RevisionConflictResponse for
 * the diverged case): `draft` — MR is flagged draft; `approvals` — fewer
 * non-author approvals than MR_REQUIRED_APPROVALS; `diverged` — target branch
 * advanced past the merge base (fast-forward precondition).
 */
export interface MergeGateConflictDetails {
  reason: 'draft' | 'approvals' | 'diverged';
  requiredApprovals?: number;
  approvals?: number;
  currentHeadRevisionId?: string | null;
  comparisonUrl?: string | null;
}

/**
 * Review threads (plan.md §8): anchors are optional and best-effort — a line
 * anchor pins the source-head revision at comment time and is shown as
 * "outdated" (not re-anchored) once that branch advances.
 */
export type MergeRequestThreadAnchor =
  | { type: 'line'; revisionId: string; line: number; excerpt?: string }
  /**
   * Feature 13 review mode: a comment left on the *rendered* page rather than
   * on a diff line. Positions are quote-based (W3C TextQuoteSelector shape) —
   * line numbers do not survive rendering, and a quote plus its surrounding
   * context re-finds itself after edits that shift every line number.
   */
  | { type: 'text'; revisionId: string; quote: string; prefix?: string; suffix?: string }
  | { type: 'section'; heading: string }
  | { type: 'entity'; entityKey: string };

/**
 * Anchors are not a merge-request idea — the same quote-based selector pins a
 * comment to a passage of a *published* page (feature 15). The MR-prefixed name
 * is kept because it is the one already on the wire.
 */
export type ReviewThreadAnchor = MergeRequestThreadAnchor;

export interface ReviewComment {
  commentId: string;
  threadId: string;
  authorId: string;
  body: string;
  /**
   * The comment this one answers, when it answers one in particular rather
   * than the thread as a whole. Null on the opening comment, and on a reply
   * written to the discussion at large.
   *
   * The comment list stays flat and createdAt-ordered — this is attribution,
   * not nesting. A reader needs to know *which* remark a reply picks up; they
   * do not need the tree that indenting a conversation would produce, and a
   * thread that anchors to one passage is short enough not to want one.
   */
  replyToId: string | null;
  createdAt: string;
  /**
   * When the author last rewrote the body, or null while it stands as first
   * posted. A discussion is a record of what people said, so an edit is shown
   * as an edit rather than silently replacing the text.
   */
  updatedAt: string | null;
}

/**
 * PATCH .../threads/:threadId/comments/:commentId — only the comment's own
 * author may rewrite it (403 otherwise); resolving a thread never locks it.
 */
export interface UpdateReviewCommentRequest {
  body: string;
}

/**
 * DELETE .../threads/:threadId/comments/:commentId — the comment's own author
 * only, like editing.
 *
 * `thread` comes back null when the deleted comment was the last one in it: a
 * discussion with nothing said in it is not a discussion, so it goes too, and
 * the client drops the card rather than rendering an empty one. Replies that
 * pointed at the deleted comment keep their place and lose their attribution
 * (`replyToId` becomes null) rather than being deleted along with it.
 */
export interface DeleteReviewCommentResponse {
  threadId: string;
  thread: ReviewThread | null;
}

/**
 * What every discussion has regardless of what it hangs off: a resolvable
 * thread holding a flat, createdAt-ordered comment list. The subject id is
 * added by the extending interface, which is what lets one ThreadCard render
 * both a review thread and a page comment.
 */
/**
 * Who opened a discussion. The assistant posts under the identity of whoever
 * ran it, so the author id cannot answer this — and a reader deciding how much
 * weight to give a remark needs to know whether a person or a model wrote it.
 */
export type ReviewThreadSource = 'human' | 'ai';

export interface ReviewThread {
  threadId: string;
  source: ReviewThreadSource;
  /**
   * GitLab's two shapes of remark: `false` is a plain comment (says
   * something), `true` a thread (asks for something, and is not done until
   * someone resolves it). Only a resolvable thread shows Resolve, and only an
   * unresolved resolvable thread counts against a merge.
   */
  resolvable: boolean;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  anchor: ReviewThreadAnchor | null;
  comments: ReviewComment[];
  createdAt: string;
}

export type MergeRequestComment = ReviewComment;

export interface MergeRequestThread extends ReviewThread {
  mergeRequestId: string;
}

// GET /v1/merge-requests/:id/threads
export interface ListMergeRequestThreadsResponse {
  mergeRequestId: string;
  threads: MergeRequestThread[];
}

// POST /v1/merge-requests/:id/threads (maps onto MCP knowledge_comment_merge_request)
export interface CreateMergeRequestThreadRequest {
  body: string;
  anchor?: MergeRequestThreadAnchor;
  /** Defaults to true (a thread); false posts a plain comment. */
  resolvable?: boolean;
  /** Defaults to 'human'; 'ai' marks a finding posted from an assistant review. */
  source?: ReviewThreadSource;
}

// POST /v1/merge-requests/:id/threads/:threadId/comments
export interface CreateMergeRequestCommentRequest {
  body: string;
  /** Comment in this thread that the reply answers; omitted replies to the thread. */
  replyToId?: string;
}

// PATCH /v1/merge-requests/:id/threads/:threadId/comments/:commentId
export type UpdateMergeRequestCommentRequest = UpdateReviewCommentRequest;

// DELETE /v1/merge-requests/:id/threads/:threadId/comments/:commentId
export interface DeleteMergeRequestCommentResponse extends DeleteReviewCommentResponse {
  thread: MergeRequestThread | null;
}

// PATCH /v1/merge-requests/:id/threads/:threadId
export interface ResolveMergeRequestThreadRequest {
  resolved: boolean;
}

// ---------------------------------------------------------------------------
// Feature 15 — comments on the page
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

// POST /v1/documents/:id/threads
export interface CreateDocumentThreadRequest {
  body: string;
  anchor?: ReviewThreadAnchor;
  /** Defaults to true (a thread); false posts a plain comment. */
  resolvable?: boolean;
  /** Defaults to 'human'; 'ai' marks a finding posted from an assistant review. */
  source?: ReviewThreadSource;
}

// POST /v1/documents/:id/threads/:threadId/comments
export interface CreateDocumentCommentRequest {
  body: string;
  /** Comment in this thread that the reply answers; omitted replies to the thread. */
  replyToId?: string;
}

// PATCH /v1/documents/:id/threads/:threadId/comments/:commentId
export type UpdateDocumentCommentRequest = UpdateReviewCommentRequest;

// DELETE /v1/documents/:id/threads/:threadId/comments/:commentId
export interface DeleteDocumentCommentResponse extends DeleteReviewCommentResponse {
  thread: DocumentThread | null;
}

// PATCH /v1/documents/:id/threads/:threadId
export interface ResolveDocumentThreadRequest {
  resolved: boolean;
}

export interface DocumentThreadResponse {
  thread: DocumentThread;
}

// ---------------------------------------------------------------------------
// Phase 4 — inference, confidence-classed facts, entity traversal
// ---------------------------------------------------------------------------

/**
 * Fact classes (plan.md §5), by trust: explicit > frontmatter (deterministic)
 * > curated (user-confirmed) > inferred (LLM). Curated facts are never
 * silently overwritten by automated re-extraction.
 */
export type FactExtractor = 'explicit' | 'frontmatter' | 'inferred' | 'curated';

// POST /v1/documents/:id/relations/curate
export interface CurateRelationRequest {
  relation: RelationInput;
}

export interface EntitySummary {
  key: string;
  type: string;
  name: string;
  /** Number of relation edges touching this entity in the workspace. */
  degree: number;
}

// GET /v1/entities?workspaceId=
export interface ListEntitiesResponse {
  entities: EntitySummary[];
}

export interface EntityRelationEdge {
  documentId: string;
  documentTitle: string;
  entityKey: string;
  relationType: string;
  extractor: FactExtractor | string;
  confidence: number;
  /** 'out' = document → entity (all stored edges point that way). */
  direction: 'out';
}

// GET /v1/entities/:key/neighbors (plan.md §9 knowledge.find_relations)
export interface EntityNeighborsResponse {
  entity: EntityRef;
  /** Edges touching the entity (depth 1). */
  edges: EntityRelationEdge[];
  /** Entities reachable within `depth` hops via shared documents. */
  relatedEntities: Array<EntityRef & { distance: number }>;
}

// POST /v1/entities/:key/impact-analysis
export interface ImpactAnalysisRequest {
  workspaceId: string;
  /**
   * 'dependents' (default): what is impacted if this entity changes —
   * documents referencing it, then the entities those documents DESCRIBE.
   * 'dependencies': what this entity relies on — entities referenced by the
   * documents that DESCRIBE it.
   */
  direction?: 'dependents' | 'dependencies';
  /** Entity hops, default 3, max 5. */
  maxDepth?: number;
}
export interface ImpactPathStep {
  kind: 'entity' | 'document';
  id: string;
  label: string;
  /** Edge type that led here (absent on the starting node). */
  viaType?: string;
}
export interface ImpactedNode {
  entity: EntityRef;
  distance: number;
  path: ImpactPathStep[];
}
export interface ImpactAnalysisResponse {
  entity: EntityRef;
  direction: 'dependents' | 'dependencies';
  impactedEntities: ImpactedNode[];
  /** Documents on any impact path. */
  affectedDocuments: Array<{ documentId: string; title: string; distance: number }>;
}

// GET /v1/entities/trace?workspaceId&from&to (plan.md §9 knowledge.trace_relation)
export interface TraceRelationResponse {
  from: string;
  to: string;
  /** Alternating entity/document steps, or null when no path exists. */
  path: ImpactPathStep[] | null;
  hops: number | null;
}

// ---------------------------------------------------------------------------
// Phase 5 — governance & scale: auth/ACLs, audited operator queries,
// stale detection / reindex scheduling, historical fact queries
// ---------------------------------------------------------------------------

/** Workspace role hierarchy: viewer < editor < admin. */
export type WorkspaceRole = 'viewer' | 'editor' | 'admin';

export interface WorkspaceMembership {
  workspaceId: string;
  role: WorkspaceRole;
  /** Gate for POST /v1/graph/query / knowledge.query_graph (plan.md section 9). */
  trustedOperator: boolean;
}

// GET /v1/me
export interface MeResponse {
  userId: string;
  email: string;
  displayName: string;
  /** 'dev' = AUTH_MODE=none (full access); 'api-key' = Bearer API key; 'session' = login session token. */
  mode: 'dev' | 'api-key' | 'session';
  /** Platform admin (users.is_admin): full access to every workspace + user management. */
  isAdmin: boolean;
  /** Empty in dev mode (the dev principal is admin+operator everywhere). */
  memberships: WorkspaceMembership[];
}

// POST /v1/graph/query — trusted-operator only, read-only, row-limited, audited
export interface GraphQueryRequest {
  workspaceId: string;
  /** A single read-only SELECT; the server wraps it with the mandatory workspace predicate. */
  query: string;
  limit?: number;
}
export interface GraphQueryResponse {
  rows: Record<string, unknown>[];
  rowCount: number;
  /** True when the row cap cut the result off. */
  truncated: boolean;
  durationMs: number;
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  /** users.id, or a synthetic actor ("dev", "mcp-operator") outside api-key mode. */
  actor: string;
  action: string;
  params: Record<string, unknown>;
  rowCount: number | null;
  durationMs: number | null;
  ok: boolean;
  error: string | null;
  createdAt: string;
}

// GET /v1/audit-logs?workspaceId=
export interface ListAuditLogsResponse {
  workspaceId: string;
  entries: AuditLogEntry[];
}

/** A fact as asserted at a point in the revision DAG (Phase 5 historical queries). */
export interface HistoricalFact {
  type: string;
  targetKey: string;
  entityType: string;
  name: string;
  extractor: FactExtractor | string;
  confidence: number;
  /** Revision that asserted the fact; null for un-anchored document-level facts. */
  assertedByRevisionId: string | null;
}

// GET /v1/documents/:id/facts?at=<revisionId>
export interface FactsAtResponse {
  documentId: string;
  atRevisionId: string;
  /**
   * The ancestor revision whose revision-scoped fact set is the effective
   * snapshot at `at` (null when no ancestor asserted revision-scoped facts).
   */
  effectiveRevisionId: string | null;
  facts: HistoricalFact[];
}

export interface FactTimelineEntry {
  type: string;
  targetKey: string;
  extractor: FactExtractor | string;
  status: 'active' | 'removed';
  introducedInRevisionId: string | null;
  introducedAt: string | null;
  /** First later revision that asserted facts without this one (removed-facts audit). */
  removedInRevisionId: string | null;
  removedAt: string | null;
}

// GET /v1/documents/:id/facts/timeline?branch=
export interface FactTimelineResponse {
  documentId: string;
  branch: string;
  entries: FactTimelineEntry[];
}

// GET /v1/ingestion/jobs/:id
export interface IngestionJobInfo {
  jobId: string;
  workspaceId: string;
  revisionId: string;
  type: string;
  status: IngestionJobStatus | string;
  attempts: number;
  error: unknown;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// GET /v1/ingestion/stale?workspaceId=
export interface StaleReportResponse {
  workspaceId: string;
  /** Current embedding signature (provider:model:dim); heads indexed under a different one are drifted. */
  embeddingSignature: string;
  driftedHeads: Array<{
    documentId: string;
    revisionId: string;
    title: string;
    embeddingModel: string | null;
    indexedAt: string | null;
  }>;
  stuckIndexing: Array<{ jobId: string; revisionId: string; startedAt: string | null }>;
  failedJobs: Array<{ jobId: string; revisionId: string; attempts: number; error: unknown }>;
}

// POST /v1/ingestion/reindex
export interface ReindexRequest {
  workspaceId: string;
  /** Restrict to one document's branch heads. */
  documentId?: string;
}
export interface ReindexResponse {
  workspaceId: string;
  enqueued: number;
  jobIds: string[];
}

// ---------------------------------------------------------------------------
// Product features (docs/features): categorization, nesting, full content,
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

// PATCH /v1/documents/:id (features 07 + 08 + projects)
export interface UpdateDocumentRequest {
  title?: string;
  category?: DocumentCategory;
  /** null re-roots the document (moves it to the top level). */
  parentId?: string | null;
  /**
   * Move the document to another project in the same workspace. The whole
   * subtree moves with it; unless `parentId` is supplied in the same call the
   * document is re-rooted, because its old parent stays behind.
   */
  projectId?: string;
}

// GET /v1/documents/tree?workspaceId=&projectId= (feature 08 + projects)
export interface DocumentTreeNode extends DocumentSummary {
  children: DocumentTreeNode[];
}
export interface DocumentTreeResponse {
  workspaceId: string;
  /** null when the tree spans the whole workspace (no projectId filter). */
  projectId: string | null;
  roots: DocumentTreeNode[];
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

// GET /v1/activity?workspaceId=&documentId=&limit=&cursor= (feature 10)
export interface ActivityEntry {
  id: string;
  workspaceId: string;
  actor: string;
  /** e.g. 'document.created', 'revision.finalized', 'merge-request.merged'. */
  action: string;
  documentId: string | null;
  documentTitle: string | null;
  subjectId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}
export interface ListActivityResponse {
  workspaceId: string;
  entries: ActivityEntry[];
  nextCursor: string | null;
}

// GET /v1/events?workspaceId= — SSE `data:` payload (feature 04)
export interface KnowledgeEvent {
  /** 'revision.indexed' | 'revision.failed' | 'revision.dependent-reindex' | activity actions. */
  type: string;
  workspaceId: string;
  documentId?: string;
  revisionId?: string;
  /** Secondary subject (branch name, merge request id, entity key, ...). */
  subjectId?: string;
  title?: string;
  actor?: string;
  /** Live data patching: changed fields of the tracked entity, mergeable into cached copies (present on document.updated & co). */
  patch?: Record<string, unknown>;
  at: string;
}

/** Event types the platform emits today — the tracking-config vocabulary (event.type stays an open string for forward compat). */
export const KNOWN_EVENT_TYPES = [
  'document.created',
  'document.updated',
  'project.created',
  'project.updated',
  'project.deleted',
  'branch.created',
  'revision.finalized',
  'revision.indexed',
  'revision.failed',
  'revision.dependent-reindex',
  'relations.curated',
  'relations.deleted',
  'merge-request.created',
  'merge-request.approved',
  'merge-request.merged',
  'merge-request.closed',
  'merge-request.updated',
  'merge-request.reopened',
  'merge-request.review-requested',
  'merge-request.comment.created',
  'merge-request.comment.resolved',
  'merge-request.comment.deleted',
  'document.comment.created',
  'document.comment.resolved',
  'document.comment.deleted',
  'import.parsed',
  'import.failed',
  'import.submitted',
  'workflow-run.started',
  'workflow-run.paused',
  'workflow-run.resumed',
  'workflow-run.completed',
  'workflow-run.failed',
  'workflow-run.cancelled',
  'workflow-node.awaiting-review',
  'workflow-node.materialized',
  'workflow-node.failed',
] as const;
export type KnownEventType = (typeof KNOWN_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Live tracked-entity updates over WebSocket (/v1/events/ws)
// ---------------------------------------------------------------------------
// A socket authenticates via ?token= (same rules as HTTP), then subscribes to
// one or more workspaces. Each subscription is ACL-checked (viewer role) and
// carries a client-side tracking configuration; the server additionally
// enforces its own LIVE_TRACKED_EVENTS allowlist. Errors reuse the strict
// ApiErrorPayload envelope.

/** Per-subscription tracking configuration — omitted/empty lists mean "everything I may see". */
export interface LiveTrackingConfig {
  /** Only events whose type matches one of these (exact, or 'prefix.*' glob). */
  events?: string[];
  /** Only events about these document ids. */
  documents?: string[];
}

export type LiveClientMessage =
  | { type: 'subscribe'; workspaceId: string; tracking?: LiveTrackingConfig }
  | { type: 'unsubscribe'; workspaceId: string }
  | { type: 'ping' };

export type LiveServerMessage =
  | { type: 'subscribed'; workspaceId: string; tracking: LiveTrackingConfig }
  | { type: 'unsubscribed'; workspaceId: string }
  | { type: 'event'; event: KnowledgeEvent }
  | { type: 'error'; error: ApiErrorPayload }
  | { type: 'pong' };

// POST /v1/assistant/review (feature 09)
export interface AssistantReviewRequest {
  workspaceId: string;
  title: string;
  markdown: string;
}
export interface AssistantIssue {
  severity: 'error' | 'warning' | 'suggestion';
  message: string;
  /** Heading the issue belongs to, when the model can anchor it. */
  section?: string;
}
export interface AssistantReviewResponse {
  /** False when ASSISTANT_PROVIDER=none — UI degrades instead of erroring. */
  enabled: boolean;
  issues: AssistantIssue[];
  summary: string;
}

// POST /v1/assistant/suggest (feature 09)
export interface AssistantSuggestRequest {
  workspaceId: string;
  title: string;
  markdown: string;
  /** What to produce: outline, continuation, rewrite of a section, … */
  instruction: string;
}
export interface AssistantSuggestResponse {
  enabled: boolean;
  suggestion: string;
}

// POST /v1/assistant/related (feature 09 — no LLM needed, reuses search)
export interface AssistantRelatedRequest {
  workspaceId: string;
  text: string;
  limit?: number;
}
export interface AssistantRelatedResponse {
  results: SearchResult[];
  related?: RelatedDocumentResult[];
}

// POST /v1/assistant/ask — chat about a document, grounded in its content
// and related pages found via hybrid search + graph expansion.
export interface AssistantAskTurn {
  role: 'user' | 'assistant';
  content: string;
}
export interface AssistantAskRequest {
  workspaceId: string;
  documentId: string;
  question: string;
  /** Prior turns of this conversation (most recent last). */
  history?: AssistantAskTurn[];
}
export interface AssistantAskSource {
  documentId: string;
  title: string;
  snippet?: string;
}
/** One tool execution the model performed while answering (transparency + debugging). */
export interface AssistantToolCall {
  /** search_knowledge | read_document | explore_document_graph */
  tool: string;
  /** Raw JSON arguments the model supplied (truncated). */
  arguments: string;
  /** False when the call was rejected (access control) or failed. */
  ok: boolean;
}
export interface AssistantAskResponse {
  /** False when ASSISTANT_PROVIDER=none — UI degrades instead of erroring. */
  enabled: boolean;
  answer: string;
  sources: AssistantAskSource[];
  /** Tool calls made by the harness, in order. */
  toolCalls?: AssistantToolCall[];
  /** Provider model that produced the answer. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Assistant pane: persisted multi-turn chat threads with a documents sidebar
// (docs/features/09 follow-up). The chat is an append-only intent log; the
// sidebar materializes from each assistant message's toolCalls trace rather
// than parsed chat text. AI-authored writes never touch a document directly:
// create_document makes a brand-new page (nothing existing to protect,
// mirrors the plain POST /v1/documents flow); propose_update always drafts a
// revision on a fresh branch and opens a merge request for a human to merge.
// ---------------------------------------------------------------------------

export type AssistantMessageRole = 'user' | 'assistant';

export interface AssistantThreadSummary {
  id: string;
  workspaceId: string;
  documentId: string | null;
  title: string | null;
  /** Provider profile pinned to this thread, when the member picked one. */
  providerId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Truncated content of the most recent message — history-list preview. */
  lastMessagePreview?: string;
}

/** 'ask' = read-only tools only (default, safe); 'agent' = also allows create_document/propose_update. */
export type AssistantChatMode = 'ask' | 'agent';

/** Ad hoc file content attached to one turn (e.g. from the composer's upload/drop widget) — used as extra
 * context for that turn only, never persisted verbatim into thread history. */
export interface AssistantChatAttachment {
  filename: string;
  content: string;
}

/** Generative UI: instead of only prose, the assistant can ask the chat pane to render one of a small,
 * fixed whitelist of EXISTING product components inline — the same GraphView/ActivityFeed/SearchWidget
 * already used on document pages, not bespoke chat-only widgets. `props` is forwarded verbatim to that
 * Vue component; the backend tool that produces a block validates/resolves everything in it (workspace
 * ownership of any documentId) before it ever reaches the client, so the client can render blindly. */
export type AssistantUiComponent = 'graph' | 'activity' | 'search';
export interface AssistantUiBlock {
  component: AssistantUiComponent;
  props: Record<string, unknown>;
}

/**
 * The assistant asking the user something, instead of guessing.
 *
 * Distinct from {@link AssistantUiBlock}, which renders a view: a prompt is
 * answerable, and its answer becomes the next turn. The assistant raises one
 * by calling a tool, so the pane never has to infer "it wants me to pick
 * something" by reading the prose — the same rule that keeps the documents
 * sidebar off the chat text.
 *
 * Only the newest message's prompt is live. Once it has been answered the
 * answer is in the transcript above it, so an older prompt renders as the
 * record of a question already settled.
 */
export interface AssistantPromptOption {
  value: string;
  label: string;
  /** One line of help under the option. */
  description?: string;
}

export type AssistantPromptField =
  /** Exactly one of the options — radios. */
  | { type: 'choice'; name: string; label: string; options: AssistantPromptOption[]; required?: boolean }
  /** Any number of the options — checkboxes. */
  | { type: 'checklist'; name: string; label: string; options: AssistantPromptOption[]; required?: boolean }
  /** Free text, for what the options cannot cover. */
  | { type: 'text'; name: string; label: string; placeholder?: string; multiline?: boolean; required?: boolean };

export interface AssistantFormPrompt {
  kind: 'form';
  /** What is being asked, in the assistant's own words. */
  question: string;
  fields: AssistantPromptField[];
  submitLabel?: string;
  /** Adds a free-text box so the user can answer outside the offered options. */
  allowOther?: boolean;
}

/**
 * The assistant wanted to write something while the chat was in Ask mode.
 * Rather than telling the user to go and flip a toggle, it hands them the
 * toggle: switching re-sends `intent` as an Agent turn.
 */
export interface AssistantModeSwitchPrompt {
  kind: 'mode-switch';
  /** What it will do once it can write — shown before the user agrees to it. */
  intent: string;
}

export type AssistantPrompt = AssistantFormPrompt | AssistantModeSwitchPrompt;

export interface AssistantMessageInfo {
  id: string;
  threadId: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls: AssistantToolCall[];
  sources: AssistantAskSource[];
  uiBlocks: AssistantUiBlock[];
  /** Set when the turn ended by asking the user something. At most one per turn. */
  prompt: AssistantPrompt | null;
  createdAt: string;
}

// POST /v1/assistant/threads
export interface CreateAssistantThreadRequest {
  workspaceId: string;
  /** Page the pane was opened from, if any — used as default chat grounding. */
  documentId?: string;
  title?: string;
}
export interface CreateAssistantThreadResponse {
  thread: AssistantThreadSummary;
}

// GET /v1/assistant/threads?workspaceId=&search=&limit=&cursor=
export interface ListAssistantThreadsRequest {
  workspaceId: string;
  /** Case-insensitive substring over the thread title and its last message. */
  search?: string;
  /** Omit for the default page; with it, the roster is cursor-paginated (rail virtualization). */
  limit?: number;
  cursor?: string;
}
export interface ListAssistantThreadsResponse {
  threads: AssistantThreadSummary[];
  /** Null when this page is the last one. */
  nextCursor: string | null;
}

// GET /v1/assistant/threads/:id
export interface GetAssistantThreadResponse {
  thread: AssistantThreadSummary;
  messages: AssistantMessageInfo[];
}

// PATCH /v1/assistant/threads/:id
export interface UpdateAssistantThreadRequest {
  /** null clears the manual title, letting the first message's derived title show again. */
  title?: string | null;
}
export interface UpdateAssistantThreadResponse {
  thread: AssistantThreadSummary;
}

// DELETE /v1/assistant/threads/:id — the thread and its whole message history.
export interface DeleteAssistantThreadResponse {
  ok: boolean;
}

// DELETE /v1/assistant/threads/:id/messages/:messageId
// Rewinds the thread: drops that message and every message after it. What the
// per-message reset and edit controls cut with — both cut inclusively, which
// is why there is no mode flag.
export interface TruncateAssistantThreadResponse {
  /** How many messages were dropped. */
  removed: number;
  thread: AssistantThreadSummary;
  /** The surviving history, oldest first — the client replaces its state with this. */
  messages: AssistantMessageInfo[];
}

// POST /v1/assistant/threads/:id/messages
export interface PostAssistantMessageRequest {
  content: string;
  /** Overrides the thread's default grounding document for this turn. */
  documentId?: string;
  /** Defaults to 'ask' server-side when omitted. */
  mode?: AssistantChatMode;
  attachments?: AssistantChatAttachment[];
  /** Existing workspace documents manually picked ("Apply documents" widget) to ground this turn in,
   * in addition to (or instead of) the thread's default grounding document. Full content is fetched
   * server-side from the documentId — the model never receives raw pasted text for these. */
  documentRefs?: string[];
}
export interface PostAssistantMessageResponse {
  /** False when ASSISTANT_PROVIDER=none — UI degrades instead of erroring. */
  enabled: boolean;
  userMessage: AssistantMessageInfo;
  assistantMessage: AssistantMessageInfo;
}

/** create_document tool result surfaced to the sidebar (new page, live immediately). */
export interface AssistantCreatedDocument {
  documentId: string;
  title: string;
  status: RevisionStatus;
}
/** propose_update tool result surfaced to the sidebar (open merge request awaiting review). */
export interface AssistantProposedUpdate {
  documentId: string;
  documentTitle: string;
  mergeRequestId: string;
  branch: string;
  title: string;
}

/**
 * Live pane events over the existing SSE bus (GET /v1/events, same
 * KnowledgeEvent envelope, subjectId = threadId): coarse-grained turn
 * lifecycle so the chat can show "thinking" / tool-call chips while waiting
 * on the (non-streaming) provider response, without a second transport.
 */
export const ASSISTANT_EVENT_TYPES = [
  'assistant.turn.started',
  'assistant.tool-call.started',
  'assistant.tool-call.finished',
  'assistant.turn.finished',
] as const;
export type AssistantEventType = (typeof ASSISTANT_EVENT_TYPES)[number];

// ---------------------------------------------------------------------------
// Streamed turn: POST /v1/assistant/threads/:id/messages/stream
// ---------------------------------------------------------------------------
// Same turn as POST .../messages, delivered as it happens instead of in one
// response. It is a POST, so EventSource cannot read it — the client posts
// with fetch and parses the `text/event-stream` body itself (which also means
// the Authorization header works normally, no ?token= escape hatch).
//
// The harness runs in rounds: the model may narrate, call tools, then narrate
// again. Every round's prose streams as `delta` frames; a `tool-call` frame
// with phase 'started' closes the current round, so the client folds whatever
// it has buffered into the visible reasoning trail and starts a fresh buffer.
// Only the final round survives as the persisted message, which arrives whole
// in `done` — so a client that ignores every delta still ends up correct.

export interface AssistantStreamStep {
  /** Prose the model produced before it reached for a tool — its reasoning out loud. */
  text: string;
  /** Tool calls that closed this step. */
  toolCalls: AssistantToolCall[];
}

export type AssistantStreamFrame =
  /** The user's turn, persisted, with its real id — replaces the client's optimistic copy. */
  | { type: 'user-message'; message: AssistantMessageInfo }
  /** Coarse phase for the status line, ahead of any token. */
  | { type: 'status'; phase: 'thinking' | 'responding' }
  /** A chunk of the current round's prose. Append verbatim; never re-order. */
  | { type: 'delta'; text: string }
  /** Tool lifecycle. 'started' also means "close the current round". */
  | { type: 'tool-call'; phase: 'started'; tool: string; arguments?: string }
  | { type: 'tool-call'; phase: 'finished'; tool: string; ok: boolean }
  /** A generative-UI block resolved server-side, safe to render as it lands. */
  | { type: 'ui-block'; block: AssistantUiBlock }
  /** The turn is ending in a question for the user; `done` carries it too. */
  | { type: 'prompt'; prompt: AssistantPrompt }
  /** Grounding documents accumulated so far — the sidebar can fill in mid-turn. */
  | { type: 'sources'; sources: AssistantAskSource[] }
  /** Terminal success: the persisted assistant message, authoritative over every delta. */
  | { type: 'done'; message: AssistantMessageInfo }
  /** Terminal failure. The user message is already persisted; the turn is not. */
  | { type: 'error'; error: ApiErrorPayload };

// ---------------------------------------------------------------------------
// Auth flow — login / signup / password restoration (session tokens on top of
// Phase 5 api-key auth) + users & access-control management.
// ---------------------------------------------------------------------------

// POST /v1/auth/signup
export interface SignupRequest {
  email: string;
  displayName: string;
  password: string;
}

// POST /v1/auth/login
export interface LoginRequest {
  email: string;
  password: string;
}

/** Returned by signup and login: a `ks_` session token (send as Bearer). */
export interface AuthSessionResponse {
  token: string;
  expiresAt: string;
  me: MeResponse;
}

// POST /v1/auth/logout
export interface LogoutResponse {
  ok: boolean;
}

// POST /v1/auth/forgot-password
export interface ForgotPasswordRequest {
  email: string;
}
export interface ForgotPasswordResponse {
  /** Always true — the endpoint never reveals whether the email exists. */
  ok: boolean;
  /** Reset token echoed back in development only (no mail provider configured). */
  debugToken?: string;
}

// POST /v1/auth/reset-password
export interface ResetPasswordRequest {
  token: string;
  password: string;
}
export interface ResetPasswordResponse {
  ok: boolean;
}

// POST /v1/auth/change-password (authenticated)
export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

// ---------------------------------------------------------------------------
// Users management (platform admin)
// ---------------------------------------------------------------------------

export interface UserSummary {
  userId: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  /** Disabled users cannot authenticate (sessions and API keys stop working). */
  disabled: boolean;
  hasPassword: boolean;
  hasApiKey: boolean;
  createdAt: string;
  memberships: WorkspaceMembership[];
}

// GET /v1/users
export interface ListUsersResponse {
  users: UserSummary[];
}

// POST /v1/users
export interface CreateUserRequest {
  email: string;
  displayName: string;
  /** Optional initial password; without one the user goes through password reset. */
  password?: string;
  isAdmin?: boolean;
}

// PATCH /v1/users/:id
export interface UpdateUserRequest {
  displayName?: string;
  isAdmin?: boolean;
  disabled?: boolean;
  /** Admin password override; revokes the user's sessions. */
  password?: string;
}

// ---------------------------------------------------------------------------
// Access control management (workspace members)
// ---------------------------------------------------------------------------

export interface WorkspaceSummary {
  workspaceId: string;
  name: string;
  createdAt: string;
  memberCount: number;
  /** Caller's role in this workspace (null for platform admins listing foreign workspaces). */
  myRole: WorkspaceRole | null;
}

// GET /v1/workspaces
export interface ListWorkspacesResponse {
  workspaces: WorkspaceSummary[];
}

// POST /v1/workspaces
export interface CreateWorkspaceRequest {
  name: string;
}
export interface CreateWorkspaceResponse {
  workspaceId: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Projects — the organizational layer between a workspace and its documents.
// Projects carry no ACLs of their own: access is resolved at the workspace.
// ---------------------------------------------------------------------------

export interface ProjectSummary {
  projectId: string;
  workspaceId: string;
  name: string;
  description: string | null;
  documentCount: number;
  createdAt: string;
}

// GET /v1/projects?workspaceId=&search=&limit=&cursor=
export interface ListProjectsRequest {
  workspaceId: string;
  search?: string;
  /** Omit for the whole roster in one response; with it, the page is cursor-paginated. */
  limit?: number;
  cursor?: string;
}
export interface ListProjectsResponse {
  projects: ProjectSummary[];
  /** Always null when the request carried no `limit`. */
  nextCursor: string | null;
}

// POST /v1/projects
export interface CreateProjectRequest {
  workspaceId: string;
  name: string;
  description?: string | null;
}
export interface CreateProjectResponse {
  project: ProjectSummary;
}

// PATCH /v1/projects/:id
export interface UpdateProjectRequest {
  name?: string;
  description?: string | null;
}

export interface WorkspaceMemberEntry {
  userId: string;
  email: string;
  displayName: string;
  role: WorkspaceRole;
  trustedOperator: boolean;
  disabled: boolean;
  createdAt: string;
}

// GET /v1/workspaces/:id/members
export interface ListWorkspaceMembersResponse {
  workspaceId: string;
  members: WorkspaceMemberEntry[];
}

/**
 * A user who is *not* yet a member of the workspace — what the add-member
 * picker searches. Deliberately thinner than {@link UserSummary}: workspace
 * admins are not platform admins, so they see identity only, never
 * credentials, the platform-admin flag or foreign memberships.
 */
export interface WorkspaceCandidate {
  userId: string;
  email: string;
  displayName: string;
  /** Disabled accounts cannot authenticate; adding one is legal but inert. */
  disabled: boolean;
}

// GET /v1/workspaces/:id/candidates?q=&limit=
export interface ListWorkspaceCandidatesResponse {
  workspaceId: string;
  candidates: WorkspaceCandidate[];
}

// POST /v1/workspaces/:id/members — add (or update) a member by email
export interface AddWorkspaceMemberRequest {
  email: string;
  role: WorkspaceRole;
  trustedOperator?: boolean;
}

// PATCH /v1/workspaces/:id/members/:userId
export interface UpdateWorkspaceMemberRequest {
  role?: WorkspaceRole;
  trustedOperator?: boolean;
}

// ---------------------------------------------------------------------------
// Strict error contract
// ---------------------------------------------------------------------------
// Every non-2xx API response serializes to the ApiErrorPayload envelope
// (apps/api ApiExceptionFilter). The web client normalizes ALL failures —
// HTTP errors, malformed bodies, network failures, timeouts, aborts — into
// the same shape, so consumers branch on `code`, never on message strings.

/**
 * Stable machine-readable error codes. The first block is emitted by the API;
 * the codes after the marker are synthesized client-side only (statusCode 0)
 * and never appear on the wire.
 */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  // feature 16: the uploaded file is not a format any parser handles
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
  // feature 12: the caller's or the workspace's monthly token budget is spent
  'ASSISTANT_BUDGET_EXCEEDED',
  'INTERNAL',
  // client-side synthesized — never sent by the API:
  'NETWORK_ERROR',
  'TIMEOUT',
  'ABORTED',
  'UNKNOWN',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The one true error envelope. */
export interface ApiErrorPayload {
  /** HTTP status; 0 for client-synthesized errors (network/timeout/abort). */
  statusCode: number;
  code: ApiErrorCode;
  /** Human-readable summary — never parse it; branch on `code`/`details`. */
  message: string;
  /** Machine-readable extras: validation `errors[]`, conflict `comparisonUrl`, ... */
  details?: Record<string, unknown>;
  /** Request path (best-effort client-side). */
  path: string;
  /** ISO-8601 moment the error was produced. */
  timestamp: string;
  /** Correlation id — echoed from/into the x-request-id header ('' when unknown). */
  requestId: string;
}

/** Default code for an HTTP status (shared by the API filter and the web client). */
export function errorCodeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHENTICATED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 415: return 'UNSUPPORTED_MEDIA_TYPE';
    case 429: return 'RATE_LIMITED';
    case 502:
    case 503:
    case 504: return 'UPSTREAM_UNAVAILABLE';
    default: return status >= 500 ? 'INTERNAL' : status >= 400 ? 'BAD_REQUEST' : 'UNKNOWN';
  }
}

/** Runtime guard: does an unknown response body conform to the envelope? */
export function isApiErrorPayload(value: unknown): value is ApiErrorPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.statusCode === 'number' &&
    typeof v.message === 'string' &&
    typeof v.code === 'string' &&
    (API_ERROR_CODES as readonly string[]).includes(v.code) &&
    typeof v.path === 'string' &&
    typeof v.timestamp === 'string' &&
    typeof v.requestId === 'string' &&
    (v.details === undefined || (typeof v.details === 'object' && v.details !== null))
  );
}

// ---------------------------------------------------------------------------
// API reference (live OpenAPI) + self-service API keys + API assistant.
// GET /v1/api-docs serves the RUNNING server's swagger schema (grouped by
// tag), so the in-app reference can never drift from the deployed routes.
// ---------------------------------------------------------------------------

export type ApiHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface ApiEndpointSummary {
  method: ApiHttpMethod;
  path: string;
  summary?: string;
  operationId?: string;
  deprecated?: boolean;
}

/** One sidebar/page section — a swagger tag with its endpoints. */
export interface ApiDocsSection {
  tag: string;
  endpoints: ApiEndpointSummary[];
}

// GET /v1/api-docs
export interface GetApiDocsResponse {
  title: string;
  description: string;
  version: string;
  sections: ApiDocsSection[];
}

export interface ApiEndpointParameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required: boolean;
  description?: string;
  /** Resolved JSON schema ($refs inlined, cycle-guarded). */
  schema?: unknown;
}

export interface ApiEndpointResponseInfo {
  status: string;
  description?: string;
  schema?: unknown;
}

export interface ApiEndpointDetail extends ApiEndpointSummary {
  description?: string;
  tags: string[];
  parameters: ApiEndpointParameter[];
  requestBodyRequired?: boolean;
  /** Resolved JSON schema of the request body (application/json). */
  requestBody?: unknown;
  responses: ApiEndpointResponseInfo[];
}

// GET /v1/api-docs/endpoint?method=&path=
export interface GetApiEndpointDetailResponse {
  endpoint: ApiEndpointDetail;
}

// GET /v1/auth/api-key — does the caller have an API key on file?
export interface ApiKeyStatusResponse {
  hasKey: boolean;
}
// POST /v1/auth/api-key — (re)issue own key; the plaintext is returned exactly
// once (only its SHA-256 is stored). Replaces any previous key.
export interface CreateApiKeyResponse {
  apiKey: string;
}
// DELETE /v1/auth/api-key
export interface RevokeApiKeyResponse {
  ok: boolean;
}

// POST /v1/assistant/api — chat about the REST API itself. Grounded in the
// live OpenAPI schema via tools (list/describe endpoints); no workspace data.
export interface AssistantApiAskRequest {
  question: string;
  history?: AssistantAskTurn[];
}
export interface AssistantApiAskResponse {
  enabled: boolean;
  answer: string;
  toolCalls?: AssistantToolCall[];
  model?: string;
}

// ---------------------------------------------------------------------------
// AI settings (docs/features/12) — the assistant layer made administrable per
// workspace: provider config, skills, MCP plugins, token accounting, call log.
// ---------------------------------------------------------------------------

/** Which layer an effective config field came from. */
export type AiSettingsSource = 'db' | 'env';
export interface AiSettingsSourceMap {
  provider: AiSettingsSource;
  baseUrl: AiSettingsSource;
  model: AiSettingsSource;
  apiKey: AiSettingsSource;
  temperature: AiSettingsSource;
  maxToolCalls: AiSettingsSource;
  timeoutMs: AiSettingsSource;
}

export type AiProvider = 'none' | 'openai-compatible' | 'deepseek' | 'gen-api';

// GET /v1/ai/settings?workspaceId= — the credential itself is never returned.
export interface AiSettingsResponse {
  workspaceId: string;
  provider: AiProvider;
  baseUrl: string;
  model: string;
  /** A key is configured (from the DB or from env). */
  hasApiKey: boolean;
  /** Last-4 hint of the stored key, when one is stored in the DB. */
  apiKeyHint: string | null;
  temperature: number;
  maxToolCalls: number;
  timeoutMs: number;
  agentModeEnabled: boolean;
  pricePromptPerMTok: number | null;
  priceCompletionPerMTok: number | null;
  /** Quotas. null = unlimited; only enforced while enforceBudget is true. */
  workspaceMonthlyTokenBudget: number | null;
  defaultUserMonthlyTokenBudget: number | null;
  enforceBudget: boolean;
  sources: AiSettingsSourceMap;
  /** Per-purpose routing into the workspace's provider profiles. */
  routing: AiRouting;
  /** False when SETTINGS_ENCRYPTION_KEY is unset — the UI must disable key entry. */
  canStoreSecrets: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

// ---- Provider profiles & routing -------------------------------------------

export type AiProviderKind = 'openai-compatible' | 'deepseek' | 'gen-api';
export type AiProviderStatus = 'unknown' | 'ok' | 'error';

/**
 * A named provider profile. Several can exist per workspace; each purpose is
 * routed at one of them, and a chat thread may pin its own.
 */
export interface AiProviderSummary {
  id: string;
  workspaceId: string;
  name: string;
  provider: AiProviderKind;
  baseUrl: string | null;
  model: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  temperature: number | null;
  maxToolCalls: number | null;
  timeoutMs: number | null;
  pricePromptPerMTok: number | null;
  priceCompletionPerMTok: number | null;
  enabled: boolean;
  status: AiProviderStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
// GET /v1/ai/providers?workspaceId=
export interface ListAiProvidersResponse {
  providers: AiProviderSummary[];
}

/**
 * What a provider is being used for. Chat and agent turns, background draft
 * review/suggestion, and the worker's relation extraction are the three jobs
 * a workspace may want on different models.
 */
export type AiPurpose = 'chat' | 'review' | 'extraction';

/** Which profile serves each purpose. null = fall back to the inline config, then env. */
export interface AiRouting {
  chat: string | null;
  review: string | null;
  extraction: string | null;
}

/**
 * The provider choices a member may make for a thread — name and model only,
 * never endpoints or credentials, since this is readable by any viewer.
 */
export interface AiProviderChoice {
  id: string;
  name: string;
  model: string;
}
// GET /v1/ai/providers/choices?workspaceId=
export interface ListAiProviderChoicesResponse {
  /** Empty when the workspace defines no profiles — the picker stays hidden. */
  providers: AiProviderChoice[];
  /** The profile the workspace routes chat at, when there is one. */
  defaultProviderId: string | null;
}

// POST /v1/ai/settings/test
export interface AiConnectionTestResponse {
  ok: boolean;
  model: string;
  latencyMs: number;
  error?: string;
}

// ---- Skills ----------------------------------------------------------------

export interface AiSkillSummary {
  id: string;
  workspaceId: string;
  name: string;
  description: string;
  instructions: string;
  triggers: string[];
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}
// GET /v1/ai/skills?workspaceId=
export interface ListAiSkillsResponse {
  skills: AiSkillSummary[];
}

// ---- Plugins (MCP servers) -------------------------------------------------

export type AiPluginTransport = 'streamable-http' | 'sse';
export type AiPluginStatus = 'unknown' | 'connected' | 'error';

/** One tool discovered from an MCP server's listTools(). */
export interface AiPluginTool {
  name: string;
  description: string;
  /** The server's own JSON Schema for the tool's arguments, passed to the model verbatim. */
  inputSchema?: Record<string, unknown>;
}

export interface AiPluginSummary {
  id: string;
  workspaceId: string;
  name: string;
  transport: AiPluginTransport;
  url: string;
  authHeader: string | null;
  /** A credential is stored for this plugin (the value itself is never returned). */
  hasAuthValue: boolean;
  enabled: boolean;
  /** Tools offered to the model. Empty = every discovered tool. */
  enabledTools: string[];
  discoveredTools: AiPluginTool[];
  status: AiPluginStatus;
  lastError: string | null;
  lastCheckedAt: string | null;
  createdAt: string;
  updatedAt: string;
}
// GET /v1/ai/plugins?workspaceId=
export interface ListAiPluginsResponse {
  plugins: AiPluginSummary[];
}
// POST /v1/ai/plugins/:id/test
export interface AiPluginTestResponse {
  ok: boolean;
  tools: AiPluginTool[];
  error?: string;
}

// ---- Usage & budgets -------------------------------------------------------

export type AiUsageOperation =
  | 'ask'
  | 'chat'
  | 'chat-stream'
  | 'review'
  | 'suggest'
  | 'glossary'
  | 'import'
  | 'workflow';

/** One row of the per-user (or per-model) usage breakdown. */
export interface AiUsageBucket {
  /** userId, model name, or ISO date — depending on `groupBy`. */
  key: string;
  /** Display label resolved server-side (an email for a user bucket). */
  label: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsdMicros: number | null;
  errors: number;
}

/** A day on the usage sparkline. */
export interface AiUsageSeriesPoint {
  date: string;
  totalTokens: number;
  calls: number;
  costUsdMicros: number | null;
}

// GET /v1/ai/usage?workspaceId=&from=&to=&groupBy=user|model|day
export interface AiUsageResponse {
  from: string;
  to: string;
  groupBy: 'user' | 'model' | 'day';
  totals: {
    calls: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsdMicros: number | null;
    /** Calls with no known price — the cost total excludes them, so the UI can say so. */
    unpricedCalls: number;
    errors: number;
  };
  buckets: AiUsageBucket[];
  series: AiUsageSeriesPoint[];
}

/** One upstream LLM call, as shown in the Logs tab. */
export interface AiUsageLogEntry {
  id: string;
  userId: string;
  userLabel: string;
  operation: AiUsageOperation;
  provider: string;
  model: string;
  /** The named profile that served the call, when one did. */
  providerId: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated: boolean;
  costUsdMicros: number | null;
  durationMs: number;
  ok: boolean;
  errorCode: string | null;
  error: string | null;
  threadId: string | null;
  toolCallCount: number;
  createdAt: string;
}
// GET /v1/ai/usage/logs?workspaceId=&cursor=&userId=&operation=&ok=
export interface ListAiUsageLogsResponse {
  entries: AiUsageLogEntry[];
  nextCursor: string | null;
}

/** Budget state for one principal — drives both the admin table and the chat chip. */
export interface AiBudgetInfo {
  userId: string;
  /** null = unlimited. */
  monthlyTokenBudget: number | null;
  /** True when this user has an explicit ai_user_budgets row. */
  overridden: boolean;
  usedTokens: number;
  remainingTokens: number | null;
  enforced: boolean;
  /** Start of the current accounting month (UTC), ISO. */
  periodStart: string;
}
// GET /v1/ai/usage/me?workspaceId=
export interface AiMyUsageResponse {
  budget: AiBudgetInfo;
  calls: number;
  totalTokens: number;
  costUsdMicros: number | null;
}
// GET /v1/ai/budgets?workspaceId=
export interface ListAiBudgetsResponse {
  workspace: {
    monthlyTokenBudget: number | null;
    usedTokens: number;
    remainingTokens: number | null;
    enforced: boolean;
    periodStart: string;
  };
  users: AiBudgetInfo[];
}

/** Flat extras on the 429 raised when a budget is spent (hoisted into `details`). */
export interface AiBudgetExceededDetails {
  scope: 'user' | 'workspace';
  usedTokens: number;
  monthlyTokenBudget: number;
  periodStart: string;
}

// ---------------------------------------------------------------------------
// Glossary (docs/features/14): workspace vocabulary + automatic term linking
// ---------------------------------------------------------------------------

/** Where a term came from: hand-written, or accepted from an AI suggestion. */
export type GlossaryTermSource = 'manual' | 'ai';

export interface GlossaryTerm {
  termId: string;
  workspaceId: string;
  /** Workspace > Project > Document: vocabulary belongs to a project. */
  projectId: string;
  term: string;
  /** Alternative spellings, abbreviations and inflections that link to this entry. */
  aliases: string[];
  /** Short definition shown in the hover card wherever the term appears. */
  definition: string;
  /** Page that defines the term in full; the hover card links to it. */
  documentId: string | null;
  /** Resolved on read (no FK — a deleted page leaves the entry intact). */
  documentTitle: string | null;
  source: GlossaryTermSource;
  /** Disabled terms stay in the glossary but stop being linked in documents. */
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

// GET /v1/glossary?workspaceId=&projectId=
export interface ListGlossaryRequest {
  workspaceId: string;
  /** Absent = every project in the workspace (what the roster page shows). */
  projectId?: string;
  search?: string;
}
export interface ListGlossaryResponse {
  workspaceId: string;
  projectId: string | null;
  terms: GlossaryTerm[];
}

// POST /v1/glossary
export interface CreateGlossaryTermRequest {
  workspaceId: string;
  projectId: string;
  term: string;
  definition: string;
  aliases?: string[];
  documentId?: string | null;
  source?: GlossaryTermSource;
  enabled?: boolean;
}

// PATCH /v1/glossary/:id
export interface UpdateGlossaryTermRequest {
  term?: string;
  definition?: string;
  aliases?: string[];
  documentId?: string | null;
  enabled?: boolean;
}

// POST /v1/glossary/suggest — LLM term extraction over a page or a draft
export interface SuggestGlossaryTermsRequest {
  workspaceId: string;
  /** Read the head revision of this page. Mutually exclusive with `markdown`. */
  documentId?: string;
  /**
   * Project whose glossary the proposals are checked against. Defaults to the
   * source document's own project; required when suggesting from raw markdown.
   */
  projectId?: string;
  /** Raw draft text (the editor suggests against unsaved content). */
  markdown?: string;
  title?: string;
}

export interface GlossaryTermSuggestion {
  term: string;
  aliases: string[];
  definition: string;
  /** Occurrences counted deterministically in the source text, not by the model. */
  occurrences: number;
  /** Already in the glossary — the UI offers "update" instead of "add". */
  existingTermId: string | null;
}

export interface SuggestGlossaryTermsResponse {
  /** false when the assistant provider is `none` — the UI hints instead of erroring. */
  enabled: boolean;
  /** Project the proposals were checked against, and where accepting one puts it. */
  projectId: string | null;
  suggestions: GlossaryTermSuggestion[];
}

// ---------------------------------------------------------------------------
// Document import (docs/features/16) — a file becoming a page.
//
// Reserve → PUT → start → poll → review → submit. The bytes go straight to
// object storage exactly like revisions and attachments do; what is new is that
// a worker parses them into markdown *before* any document exists, so the
// result can be read and corrected by a human before it is committed.

/** One accepted source format: what the picker offers and what the server routes on. */
export interface ImportFormat {
  /** Parser id the server will use. */
  parser: ImportParserId;
  label: string;
  extensions: string[];
  contentTypes: string[];
}

export type ImportParserId =
  | 'pdf'
  | 'docx'
  | 'pptx'
  | 'html'
  | 'tabular'
  | 'structured'
  | 'plaintext'
  | 'ocr';

/**
 * The single source of truth for what can be imported, shared by the drop zone,
 * the server's reserve guard and the parser registry — so a file the picker
 * accepts can never be one the worker refuses.
 *
 * Order matters: the first entry whose extension or content type matches wins,
 * which is why `plaintext` (the catch-all for text/*) sits last.
 */
export const IMPORT_FORMATS: readonly ImportFormat[] = [
  {
    parser: 'pdf',
    label: 'PDF',
    extensions: ['.pdf'],
    contentTypes: ['application/pdf'],
  },
  {
    parser: 'docx',
    label: 'Word',
    extensions: ['.docx'],
    contentTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  },
  {
    parser: 'pptx',
    label: 'PowerPoint',
    extensions: ['.pptx'],
    contentTypes: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  },
  {
    parser: 'html',
    label: 'HTML',
    extensions: ['.html', '.htm'],
    contentTypes: ['text/html', 'application/xhtml+xml'],
  },
  {
    parser: 'tabular',
    label: 'Spreadsheet data',
    extensions: ['.csv', '.tsv'],
    contentTypes: ['text/csv', 'text/tab-separated-values'],
  },
  {
    parser: 'structured',
    label: 'JSON / YAML',
    extensions: ['.json', '.yaml', '.yml'],
    contentTypes: ['application/json', 'application/yaml', 'text/yaml', 'text/x-yaml'],
  },
  {
    parser: 'ocr',
    label: 'Image (OCR)',
    extensions: ['.png', '.jpg', '.jpeg', '.webp', '.gif'],
    contentTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
  },
  {
    parser: 'plaintext',
    label: 'Markdown / text',
    extensions: ['.md', '.markdown', '.txt', '.text'],
    contentTypes: ['text/markdown', 'text/plain', 'text/x-markdown'],
  },
] as const;

/** Resolve a file to its parser the same way on both sides of the wire. */
export function importFormatFor(filename: string, contentType?: string): ImportFormat | null {
  const ext = filename.toLowerCase().replace(/^.*(?=\.)/, '');
  const type = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return (
    IMPORT_FORMATS.find((f) => f.extensions.includes(ext)) ??
    IMPORT_FORMATS.find((f) => type !== '' && f.contentTypes.includes(type)) ??
    null
  );
}

/**
 * `awaiting-upload` exists because the row is created before the bytes land:
 * the presigned PUT is the client's job, and until the bucket confirms the
 * object there is nothing to parse.
 */
export type ImportStatus =
  | 'awaiting-upload'
  | 'queued'
  | 'running'
  | 'parsed'
  | 'failed'
  | 'submitted';

/** Counts the review step reports, filled in by whichever parser ran. */
export interface ImportMeta {
  pages?: number;
  slides?: number;
  sections?: number;
  words?: number;
  images?: number;
  /** A PDF with no text layer: the review step offers OCR instead of a dead end. */
  needsOcr?: boolean;
}

export interface ImportJobInfo {
  importId: string;
  workspaceId: string;
  projectId: string;
  parentId: string | null;
  category: DocumentCategory;
  status: ImportStatus;
  /** Human phrase for the current act ("Reading 48 pages"); null when idle. */
  stage: string | null;
  /** 0..1, or null when the worker cannot honestly say — the ring goes indeterminate. */
  progress: number | null;
  sourceFilename: string;
  contentType: string;
  sizeBytes: number;
  parser: ImportParserId | null;
  title: string | null;
  /** What the parse could not carry. Never swallowed. */
  warnings: string[];
  meta: ImportMeta;
  error: string | null;
  documentId: string | null;
  createdAt: string;
}

// POST /v1/imports
export interface CreateImportRequest {
  workspaceId: string;
  projectId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  category?: DocumentCategory;
  parentId?: string;
}
export interface CreateImportResponse {
  import: ImportJobInfo;
  upload: { url: string; method: 'PUT'; headers: Record<string, string>; expiresAt: string };
}

// POST /v1/imports/:id/start  and  GET /v1/imports/:id
export interface ImportJobResponse {
  import: ImportJobInfo;
}

// GET /v1/imports/:id/content
export interface ImportContentResponse {
  importId: string;
  title: string | null;
  markdown: string;
  warnings: string[];
  meta: ImportMeta;
}

// POST /v1/imports/:id/submit
export interface SubmitImportRequest {
  title: string;
  markdown: string;
  /** Destination may be corrected on the review step without re-parsing. */
  projectId?: string;
  category?: DocumentCategory;
  parentId?: string | null;
}
export interface SubmitImportResponse {
  documentId: string;
  revisionId: string;
  /** The original file, promoted from staging onto the new page. */
  attachmentId: string | null;
}

// ---------------------------------------------------------------------------
// Dynamic document workflows (docs/features/17)
// ---------------------------------------------------------------------------
// A workflow definition is a graph of steps run against a source page: one
// entity fans out into use-cases, each use-case into API endpoints and frontend
// pages. Every step parks its result as a *draft* on the run; nothing enters
// the page tree until a person approves it. The step catalogue is closed and
// each kind has an executor registered in code, so a "dynamic" workflow is
// always data — the database never carries executable logic.

/** Step kinds. Closed set: each maps to an executor in the worker. */
export const WORKFLOW_STEP_KINDS = [
  /** Fan-out: the model returns a list of items, each becoming a child node. */
  'ai.generate',
  /** Writes one node's full markdown body, with tools (search / read / graph). */
  'ai.draft',
  /** Deterministic: runs a knowledge search and attaches hits to the node input. */
  'search',
  /** A pure human gate — no model call. */
  'review',
] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

/** Run lifecycle. `paused` is operator-initiated; `awaiting-review` is the
 *  machine parking itself because every live node needs a human. */
export const WORKFLOW_RUN_STATUSES = [
  'pending',
  'running',
  'awaiting-review',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/** Node lifecycle. `materialized` is the only status that implies a Document. */
export const WORKFLOW_NODE_STATUSES = [
  'pending',
  'running',
  'awaiting-review',
  'approved',
  'materializing',
  'materialized',
  'rejected',
  'skipped',
  'failed',
] as const;
export type WorkflowNodeStatus = (typeof WORKFLOW_NODE_STATUSES)[number];

/** Events a client may send at a node. Mirrors `nodeMachine`'s event union —
 *  the web enables buttons from the compiled machine, so this list and the
 *  machine cannot drift. */
export const WORKFLOW_NODE_EVENTS = ['APPROVE', 'REJECT', 'SKIP', 'RETRY'] as const;
export type WorkflowNodeEventType = (typeof WORKFLOW_NODE_EVENTS)[number];

export const WORKFLOW_RUN_EVENTS = ['PAUSE', 'RESUME', 'CANCEL'] as const;
export type WorkflowRunEventType = (typeof WORKFLOW_RUN_EVENTS)[number];

/** What a step's approved drafts become when materialised. */
export interface WorkflowStepProduces {
  category: DocumentCategory;
  /** Edge type written from the produced page to the node's parent page. */
  relationToParent: string;
  /** Nest the produced page under the parent page (feature 08). */
  nestUnderParent?: boolean;
}

/** Scope handed to a step's tools and search — the "filters" of the feature. */
export interface WorkflowStepFilters {
  categories?: DocumentCategory[];
  projectIds?: string[];
  tags?: string[];
  limit?: number;
}

export interface WorkflowStep {
  /** Stable slug, unique within the definition. Referenced by `next` and by
   *  `workflow_run_nodes.step_id`, so renaming one orphans a running node. */
  id: string;
  kind: WorkflowStepKind;
  title: string;
  description?: string;
  /** Downstream step ids. Several entries = the fan-out of the definition
   *  graph (one use-case feeds both `api-endpoints` and `frontend-pages`). */
  next: string[];
  /** Does this step produce N children (a list) or refine its own node? */
  fanOut: boolean;
  /** Skip the human gate — the step's drafts materialise as soon as they land. */
  autoApprove: boolean;
  /** Hard cap on fan-out width, so one hallucinated list cannot open 200 nodes. */
  maxItems?: number;
  produces?: WorkflowStepProduces;
  prompt?: { system?: string; user: string };
  /** Names from the assistant tool registry this step may call. */
  tools?: string[];
  skillIds?: string[];
  /** Pin an `ai_providers` profile for this step (feature 12 routing). */
  providerId?: string | null;
  filters?: WorkflowStepFilters;
}

export interface WorkflowGraph {
  steps: WorkflowStep[];
  /** Editor-only canvas coordinates, keyed by step id. Ignored by the runtime. */
  layout?: Record<string, { x: number; y: number }>;
}

export interface WorkflowTrigger {
  /** Offer a Run button on matching pages and in /workflows. */
  manual: boolean;
  /** Start a run automatically when `events` fire on a matching page.
   *  Defaults false: the failure mode of an always-on trigger is an LLM
   *  avalanche across a whole workspace. */
  autoStart: boolean;
  events: string[];
  /** Only pages in these categories trigger. Empty = every category. */
  categories: DocumentCategory[];
}

export interface WorkflowDefinitionInfo {
  id: string;
  workspaceId: string;
  /** null = available to every project in the workspace. */
  projectId: string | null;
  name: string;
  description: string | null;
  enabled: boolean;
  version: number;
  graph: WorkflowGraph;
  trigger: WorkflowTrigger;
  createdAt: string;
  updatedAt: string;
}

/** One problem found by `compileDefinition` — surfaced live in the editor. */
export interface WorkflowValidationIssue {
  /** Absent when the problem is the graph as a whole (a cycle, no entry step). */
  stepId?: string;
  message: string;
  severity: 'error' | 'warning';
}

export interface WorkflowNodeDraft {
  title: string;
  markdown: string;
  frontmatter?: Record<string, unknown>;
  relations?: RelationInput[];
  /** Free-form summary the model produced alongside the body, shown in the tree. */
  summary?: string;
}

export interface WorkflowRunNodeInfo {
  id: string;
  runId: string;
  parentId: string | null;
  stepId: string;
  status: WorkflowNodeStatus;
  draft: WorkflowNodeDraft | null;
  /** Set once approved and materialised. */
  documentId: string | null;
  error: string | null;
  attempt: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowRunInfo {
  id: string;
  workspaceId: string;
  projectId: string;
  definitionId: string;
  definitionName: string;
  rootDocumentId: string;
  rootDocumentTitle: string | null;
  status: WorkflowRunStatus;
  error: string | null;
  /** 'manual' | 'trigger' | 'mcp' — how the run came to exist. */
  startedBy: string;
  createdBy: string;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  /** Counts for list rows, so a card never has to fetch the node tree. */
  nodeStats: { total: number; awaitingReview: number; materialized: number; failed: number };
}

// GET /v1/workflows?workspaceId=&projectId=
export interface ListWorkflowsResponse {
  workflows: WorkflowDefinitionInfo[];
}

// POST /v1/workflows
export interface CreateWorkflowRequest {
  workspaceId: string;
  projectId?: string | null;
  name: string;
  description?: string | null;
  graph: WorkflowGraph;
  trigger?: WorkflowTrigger;
  /** Described here rather than as a schema default: a `default:` in the
   *  Swagger decorator would make this required in the generated client. */
  enabled?: boolean;
}

// PATCH /v1/workflows/:id
export interface UpdateWorkflowRequest {
  name?: string;
  description?: string | null;
  projectId?: string | null;
  graph?: WorkflowGraph;
  trigger?: WorkflowTrigger;
  enabled?: boolean;
}

export interface WorkflowResponse {
  workflow: WorkflowDefinitionInfo;
}

// POST /v1/workflows/:id/validate
export interface ValidateWorkflowRequest {
  graph?: WorkflowGraph;
}
export interface ValidateWorkflowResponse {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

// GET /v1/workflows/runs?workspaceId=&projectId=&definitionId=&status=&documentId=
export interface ListWorkflowRunsResponse {
  runs: WorkflowRunInfo[];
  nextCursor: string | null;
  counts: Record<WorkflowRunStatus, number>;
}

// POST /v1/workflows/runs
export interface StartWorkflowRunRequest {
  workspaceId: string;
  definitionId: string;
  rootDocumentId: string;
  /** Seed the first step with extra instructions for this run only. */
  note?: string;
}

// GET /v1/workflows/runs/:id
export interface WorkflowRunResponse {
  run: WorkflowRunInfo;
  /** The definition as frozen at start — editing the definition afterwards
   *  must not change what a run in flight is doing. */
  graph: WorkflowGraph;
  nodes: WorkflowRunNodeInfo[];
}

// POST /v1/workflows/runs/:id/events
export interface WorkflowRunEventRequest {
  type: WorkflowRunEventType;
}

// PATCH /v1/workflows/runs/:id/nodes/:nodeId
export interface UpdateWorkflowNodeRequest {
  draft: WorkflowNodeDraft;
}

// POST /v1/workflows/runs/:id/nodes/:nodeId/events
export interface WorkflowNodeEventRequest {
  type: WorkflowNodeEventType;
  /** APPROVE may carry a last-moment edit, so review and edit are one action. */
  draft?: WorkflowNodeDraft;
}
export interface WorkflowNodeEventResponse {
  node: WorkflowRunNodeInfo;
  run: WorkflowRunInfo;
}

// GET /v1/documents/:id/workflow-runs
export interface DocumentWorkflowRunsResponse {
  documentId: string;
  runs: WorkflowRunInfo[];
  /** Definitions that may be started against this page right now. */
  available: Array<{ id: string; name: string }>;
}
