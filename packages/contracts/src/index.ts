// Shared API contract types for the Dynamic Knowledge Platform.
// Plain types only — no runtime deps, no server imports.

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
  /** Nearest common ancestor of the two heads at read time; null when unrelated or target is empty. */
  mergeBaseRevisionId: string | null;
  status: MergeRequestStatus;
  approvedBy: string[];
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

/** 409 body for If-Match / merge conflicts (plan.md §7): always carries a comparison link. */
export interface RevisionConflictResponse {
  statusCode: 409;
  message: string;
  currentHeadRevisionId: string | null;
  comparisonUrl: string | null;
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
  /** 'dev' = AUTH_MODE=none (full access); 'api-key' = authenticated via Bearer key. */
  mode: 'dev' | 'api-key';
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
  title?: string;
  actor?: string;
  at: string;
}

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
