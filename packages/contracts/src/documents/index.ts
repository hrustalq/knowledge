import type {
  ChunkSummary,
  DocumentSummary,
  DocumentTrust,
  RevisionInfo,
  RevisionStatus,
  SourceVerificationState,
} from '@knowledge/contracts/core';
import type { ApiSpecDiff } from '@knowledge/contracts/api/diff';
import type { AuthorableRelationType, EntityLayer, FactExtractor, ResolvedAsOf } from '@knowledge/contracts/graph';
import type { DeleteReviewCommentResponse, ReviewComment, ReviewThread, SemanticDiff, StructuralDiff } from '@knowledge/contracts/reviews';
import type { MentionAccessNote } from '@knowledge/contracts/identity';

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
   * `'page'` (#443): one result per page, its best-ranked chunk, `limit`
   * counting pages, each with `snippetParts`. What a person's result list
   * reads; absent, one result per chunk.
   */
  groupBy?: 'page';
  /** Search the text as it stood then (#81): an ISO date, `rev:<id>` or `tag:<name>`. */
  asOf?: string;
  /** What was believed at this ISO date (#81); only the graph expansion reads it. */
  knownAt?: string;
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
  filters?: {
    categories?: DocumentCategory[];
    projectIds?: string[];
    tags?: string[];
    /** Only pages whose derived verification state is one of these (docs/features/39). */
    verificationStates?: SourceVerificationState[];
    /** Archived pages are dropped unless asked for. */
    includeArchived?: boolean;
  };
}
export interface SearchResult {
  documentId: string;
  revisionId: string;
  chunkId: string;
  title: string;
  snippet: string;
  /**
   * With `groupBy: 'page'` (#443): a window of the chunk around the first
   * query match, the matched words as `hit` runs. No match, no `hit` run.
   */
  snippetParts?: { text: string; hit: boolean }[];
  /** The fused retrieval score after the trust re-rank (docs/features/39). */
  score: number;
  /**
   * The chunk's raw cosine from the vector leg, before fusion and trust;
   * absent when only BM25 found it. Unlike `score`, its scale does not depend
   * on which legs answered (#403).
   */
  vectorScore?: number;
  /**
   * The page's verification state, owner and inactivity, and what the re-rank
   * read (docs/features/39). On every hit, so `ask` and `knowledge_search` can
   * say which page they trusted and why.
   */
  trust?: DocumentTrust;
  /**
   * Heading trail of the matched chunk, root first. The chunk vertex has carried
   * it since Phase 1; surfacing it is what lets a citation link to a section
   * rather than a page (docs/features/38).
   */
  headingPath?: string[];
  /** Entities related to the result's document (present when expandGraph is used). */
  entities?: EntityRef[];
  /**
   * Where the page sits (#475): the abstraction layer most of its entities
   * are on (`pageLayerOf`). Absent for a page that names no entity.
   */
  layer?: EntityLayer;
  /**
   * Titles of the communities containing the page that the reader may see
   * whole, coarsest first (#475). Absent when there are none, and under
   * `asOf` — communities describe only the current graph.
   */
  communityPath?: string[];
  /**
   * When the matched text was the page's content (#81), ISO; present on an
   * `asOf` search. A `validTo` means the page has since changed: the text is
   * superseded.
   */
  validFrom?: string | null;
  validTo?: string | null;
}
/** A retrieval leg a search skipped because its store failed or timed out (#173). */
export type SearchDegradedLeg = 'fulltext';
export interface SearchResponse {
  results: SearchResult[];
  /** Documents reached only via graph expansion (not in the vector hits). */
  related?: RelatedDocumentResult[];
  /**
   * Legs that were asked for and did not run. Absent when every requested leg
   * answered: `['fulltext']` means the BM25 index was unreachable and these
   * results are vector-only.
   */
  degraded?: SearchDegradedLeg[];
  /** Present on an `asOf` search (#81). */
  resolvedAsOf?: ResolvedAsOf;
  /**
   * This search's row in the analytics log (#79), present when analytics is
   * on. The web carries it to the page a result opens (`?sid=&rank=`),
   * which is what counts a click.
   */
  searchId?: string;
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

/**
 * A person's working branch for one page (#474): `draft/<userId>`, then
 * `draft/<userId>-<n>` once publishing has used the earlier ones up. The editor
 * and `POST /v1/documents/:id/branches/mine` both read a branch by this prefix.
 */
export const DRAFT_BRANCH_PREFIX = 'draft/';

export interface BranchInfo {
  branchId: string;
  documentId: string;
  name: string;
  headRevisionId: string | null;
  protected: boolean;
  /** Who started the branch (#474); null for a branch from before then or made by the system. */
  ownerId: string | null;
  /** Private (#474): only its owner, the people they shared it with and admins read it. */
  restricted: boolean;
  createdAt: string;
}

export interface CreateBranchResponse {
  branch: BranchInfo;
}

// POST /v1/documents/:id/branches/mine
export interface MyDraftBranchResponse extends CreateBranchResponse {
  /** The pages the caller's draft has revisions on (#636), by id: what one Publish carries. */
  pages: string[];
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
  /** Null when there is nothing to compare against — a page's first merge request: every line of `to` is added. */
  from: CompareRevisionRef | null;
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
  /** Classified spec diff (#78) when the document is an API spec; null when a side does not parse. */
  api?: ApiSpecDiff | null;
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
  /**
   * Edge type. Narrowed to what may be written by hand — TAGGED_WITH is
   * synthesised from `tags:` and is never an input, so the type says so rather
   * than leaving every writer to remember it.
   */
  type: AuthorableRelationType;
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

/** One relation addressed by what identifies it: its type and its target key. */
export interface RelationRef {
  type: string;
  targetKey: string;
}

/**
 * A change to a page's *frontmatter* relations (docs/features/28).
 *
 * Deliberately not an op union: `add` + `remove` in one call expresses create,
 * update (remove then add) and delete, and validates with plain decorators —
 * a discriminated union would need a custom validator to buy nothing.
 *
 * This is a different thing from `POST /:id/relations`, which writes a graph
 * edge directly. An edge written that way is invisible in the page source and
 * is not reproducible by re-indexing; these are declared in the page's own
 * frontmatter, so they survive as deterministic facts.
 */
export interface RelationFrontmatterPatch {
  add?: RelationInput[];
  remove?: RelationRef[];
  /** Replaces the whole `tags:` list. Omit to leave tags untouched. */
  tags?: string[];
}

// POST /v1/documents/:id/relations/propose
export interface ProposeRelationsResponse {
  documentId: string;
  /** False when the patch changed nothing — no branch, revision or merge request was made. */
  changed: boolean;
  mergeRequestId: string | null;
  branch: string | null;
  title: string | null;
  /** What the patch actually did, after validation and de-duplication. */
  added: RelationInput[];
  removed: RelationRef[];
  tags: string[];
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

// PATCH /v1/documents/:id/threads/:threadId, PATCH …/comments/:commentId
export interface DocumentThreadResponse {
  thread: DocumentThread;
}

// POST /v1/documents/:id/threads, POST …/threads/:threadId/comments
export interface CreateDocumentThreadResponse extends DocumentThreadResponse, MentionAccessNote {}

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

// ---------------------------------------------------------------------------
// API contract block — the editor's endpoint widget.
//
// These live in contracts rather than in the web app for the AGENT_MENTION_ATTR
// reason: the block is written by the editor and read back by the server (the
// ingestion worker turns a block linked to a spec operation into an IMPLEMENTS
// fact), so the writer and the reader must not be able to drift apart.
// ---------------------------------------------------------------------------

/** Wrapper attribute; its value is the HTTP method. */
export const API_CONTRACT_ATTR = 'data-kn-api';
/** The endpoint path, on the same wrapper. */
export const API_PATH_ATTR = 'data-kn-path';
/**
 * The spec operation a block mirrors (#78): an `op:` or `channel:` entity key,
 * as `operationEntityKey` builds it. Set, the block renders that operation live
 * from the spec, and the page IMPLEMENTS it.
 */
export const API_OPERATION_ATTR = 'data-kn-op';
/**
 * Marks one section inside the block. The *meaning* rides here so the visible
 * label stays translatable — an exporter that matched on the label text would
 * break the moment a page was authored in Russian (docs/features/18).
 */
export const API_SECTION_ATTR = 'data-kn-api-section';

/**
 * The methods worth a block of their own. TRACE and CONNECT are omitted the way
 * a sixth panel colour is: a vocabulary nobody reaches for is a menu everyone
 * reads past.
 */
export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export function isHttpMethod(value: string): value is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(value);
}

/** Section kinds, in the order the template lays them out. */
export const API_SECTIONS = ['summary', 'params', 'body', 'responses', 'auth'] as const;
export type ApiSectionKind = (typeof API_SECTIONS)[number];

export function isApiSection(value: string): value is ApiSectionKind {
  return (API_SECTIONS as readonly string[]).includes(value);
}

// GET /v1/documents/:id/content (feature 01)
export interface DocumentContentResponse {
  documentId: string;
  revisionId: string;
  contentType: string;
  frontmatter: Record<string, unknown> | null;
  markdown: string;
  /** Present when the revision was picked by `asOf` (#81). */
  resolvedAsOf?: ResolvedAsOf;
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
  /** Entities only: the abstraction layer its key's prefix names (#475). */
  layer?: EntityLayer;
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
  /** Present when the graph was read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
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
  /** Entities only: the abstraction layer its key's prefix names (#475). */
  layer?: EntityLayer;
  /** Documents only: head-revision status, for the lifecycle dot. */
  status?: RevisionStatus | null;
  /** Incident edge count, after filtering. */
  degree: number;
  /** Documents only: the community the page belongs to, when the atlas has built them (#81). */
  community?: string;
}
export interface WorkspaceGraphResponse {
  workspaceId: string;
  /** null when the graph spans the whole workspace (no projectId filter). */
  projectId: string | null;
  nodes: WorkspaceGraphNode[];
  edges: DocumentGraphEdge[];
  /** True when the workspace holds more edges than the render cap allows. */
  truncated: boolean;
  /** Present when the graph was read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
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

// ---------------------------------------------------------------------------
// Real-time co-editing (#80, docs/features/56): one shared draft per branch.

/** `collab:{workspaceId}:{documentId}:{branchId}` — what a provider asks the `/v1/collab` socket for. */
export function collabDocName(workspaceId: string, documentId: string, branchId: string): string {
  return `collab:${workspaceId}:${documentId}:${branchId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The inverse, or `null` for anything malformed. The workspace part is a
 * routing hint only: the server re-resolves it from the document in PG.
 */
export function parseCollabDocName(
  name: string,
): { workspaceId: string; documentId: string; branchId: string } | null {
  const [prefix, workspaceId, documentId, branchId, ...rest] = name.split(':');
  if (prefix !== 'collab' || rest.length > 0) return null;
  if (![workspaceId, documentId, branchId].every((id) => id !== undefined && UUID_RE.test(id))) return null;
  return { workspaceId: workspaceId!, documentId: documentId!, branchId: branchId! };
}

/**
 * Why a document was refused or closed. Hocuspocus multiplexes documents over
 * one socket, so both arrive per document as a reason string, never a close
 * code: a refusal as `permission-denied`, a close as a close message the
 * provider reports as `{ code: 1000, reason }`. A refused page never names
 * itself (feature 48).
 *
 * - `unauthorized` — no valid `kt_` ticket, or the credential behind it has
 *   since been revoked or its account disabled.
 * - `forbidden` — the page cannot be opened (any more).
 * - `access-changed` — view stays but edit was gained or lost: rejoin with a
 *   fresh ticket to learn the new scope.
 * - `too-large` — the draft passed COLLAB_MAX_DOC_BYTES and stopped saving.
 * - `reset` — someone discarded the draft and it was reseeded from the branch
 *   head, or this device's copy is from before such a reseed
 *   (`collabToken`). Rejoin with a **new** Y.Doc and this device's copy
 *   cleared: merging the old state into the reseeded one would show the page
 *   twice.
 */
export const COLLAB_DENY_REASONS = ['unauthorized', 'forbidden', 'access-changed', 'too-large', 'reset'] as const;
export type CollabDenyReason = (typeof COLLAB_DENY_REASONS)[number];

/**
 * What a peer sends as its Hocuspocus token: its `kt_` ticket and, when this
 * device holds a copy of the draft, the generation that copy came from. A
 * draft gets a new generation whenever it is reseeded (a reset, or dropped
 * and opened again). The server refuses a copy from another generation with
 * `reset` before it syncs, so an offline copy of a discarded draft is never
 * merged into its reseed. A `kt_` ticket never contains a space.
 */
export function collabToken(ticket: string, generation: string | null): string {
  return generation ? `${ticket} ${generation}` : ticket;
}

/** The inverse. A plain ticket claims no copy. */
export function parseCollabToken(token: string): { ticket: string; generation: string | null } {
  const at = token.indexOf(' ');
  return at < 0 ? { ticket: token, generation: null } : { ticket: token.slice(0, at), generation: token.slice(at + 1) || null };
}

/** The stateless message a peer gets once it joined: the generation to remember beside its copy. */
export interface CollabJoined {
  generation: string;
}

/** The one socket-level close: COLLAB_ENABLED is off. */
export const COLLAB_DISABLED_CLOSE_CODE = 4503;

/**
 * Awareness `user`, as every peer sees it. The server overwrites these fields
 * from the connection's principal on every awareness update, so a name or
 * avatar on a caret is never the client's claim. Other fields pass through.
 */
export interface CollabUser {
  userId: string;
  name: string;
  avatarUrl: string | null;
}

/** `GET /v1/collab/capabilities` — whether this deployment co-edits, and the schema a client must match to write. */
export interface CollabCapabilitiesResponse {
  enabled: boolean;
  schemaVersion: string;
}

/** One branch's shared draft, as `GET /v1/documents/:id/drafts` reports it. */
export interface CollabDraftInfo {
  draftId: string;
  branchId: string;
  branch: string;
  /** The revision the draft was seeded from or last published as. The `If-Match` a publish sends. */
  baseRevisionId: string | null;
  /** The draft differs from what was last published (or seeded). */
  hasUnpublishedChanges: boolean;
  /** Who wrote in it since the last publish. */
  contributors: string[];
  /** People with it open, as far as this API instance can see. */
  activePeers: number;
  updatedAt: string;
}

/** Empty while COLLAB_ENABLED is off, whatever drafts an earlier run left behind. */
export interface ListCollabDraftsResponse {
  drafts: CollabDraftInfo[];
}
