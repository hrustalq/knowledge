// Shared API contract types for the Dynamic Knowledge Platform.
// Plain types + dependency-free error-contract helpers — no runtime deps, no server imports.

export type RevisionStatus = 'draft' | 'finalized' | 'indexing' | 'indexed' | 'failed';
export type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed';

export interface DocumentSummary {
  documentId: string;
  workspaceId: string;
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
  /** Feature 02 metadata filters, applied post-ranking against PG. */
  filters?: { categories?: DocumentCategory[] };
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
  /** Only merge requests with this user assigned as reviewer. */
  reviewerId?: string;
  documentId?: string;
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
  | { type: 'section'; heading: string }
  | { type: 'entity'; entityKey: string };

export interface MergeRequestComment {
  commentId: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
}

export interface MergeRequestThread {
  threadId: string;
  mergeRequestId: string;
  resolved: boolean;
  resolvedBy: string | null;
  resolvedAt: string | null;
  anchor: MergeRequestThreadAnchor | null;
  comments: MergeRequestComment[];
  createdAt: string;
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
}

// POST /v1/merge-requests/:id/threads/:threadId/comments
export interface CreateMergeRequestCommentRequest {
  body: string;
}

// PATCH /v1/merge-requests/:id/threads/:threadId
export interface ResolveMergeRequestThreadRequest {
  resolved: boolean;
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

// PATCH /v1/documents/:id (features 07 + 08)
export interface UpdateDocumentRequest {
  title?: string;
  category?: DocumentCategory;
  /** null re-roots the document (moves it to the top level). */
  parentId?: string | null;
}

// GET /v1/documents/tree?workspaceId= (feature 08)
export interface DocumentTreeNode extends DocumentSummary {
  children: DocumentTreeNode[];
}
export interface DocumentTreeResponse {
  workspaceId: string;
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

export interface AssistantMessageInfo {
  id: string;
  threadId: string;
  role: AssistantMessageRole;
  content: string;
  toolCalls: AssistantToolCall[];
  sources: AssistantAskSource[];
  uiBlocks: AssistantUiBlock[];
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

// GET /v1/assistant/threads?workspaceId=
export interface ListAssistantThreadsResponse {
  threads: AssistantThreadSummary[];
}

// GET /v1/assistant/threads/:id
export interface GetAssistantThreadResponse {
  thread: AssistantThreadSummary;
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
  'RATE_LIMITED',
  'UPSTREAM_UNAVAILABLE',
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
