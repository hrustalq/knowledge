import type { DocumentCategory, RelatedDocumentResult, SearchResult } from '@knowledge/contracts/documents';

// Shared API contract types for the Dynamic Knowledge Platform.
// Plain types + dependency-free error-contract helpers — no runtime deps, no server imports.

export type RevisionStatus = 'draft' | 'finalized' | 'indexing' | 'indexed' | 'failed';
export type IngestionJobStatus = 'queued' | 'running' | 'completed' | 'failed';

// ---------------------------------------------------------------------------
// Locales (docs/features/18) — the UI language and the language the API speaks.
// Shared so the web, the API and the worker agree on one vocabulary; document
// CONTENT is never translated, only the product around it.
// ---------------------------------------------------------------------------

export const SUPPORTED_LOCALES = ['en', 'ru'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];
/** English is the default everywhere, and the fallback when a key is missing. */
export const DEFAULT_LOCALE: Locale = 'en';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * First supported locale in an Accept-Language header, honouring q-weights.
 * Matches on the primary subtag, so `ru-RU` resolves to `ru`. Returns null when
 * nothing matches, which callers read as "fall through to the next source".
 */
export function parseAcceptLanguage(header: string | undefined | null): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.find((p) => p.trim().startsWith('q='));
      const weight = q ? Number.parseFloat(q.trim().slice(2)) : 1;
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(weight) ? weight : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of ranked) {
    if (tag === '*') return DEFAULT_LOCALE;
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}

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

export interface CreateDocumentResponse {
  documentId: string;
  revisionId: string;
  branch: string;
  status: RevisionStatus;
}

// ---------------------------------------------------------------- attachments
// Confluence-style page attachments: images, PDFs and files embedded in the
//
// One classifier, shared by the API (which aggregates the calendar server-side)
// and the web (which colours a legend and filters a list from the same names),
// for the reason `importFormatFor` is shared: two copies of a prefix table
// drift, and then a day's ink and that day's list disagree about what happened.
//
// Deliberately NOT stored on activity_log. The action string is the durable
// fact; the kind is a reading of it, and a reading may be re-cut later without
// a migration. An unknown action is 'curate' rather than dropped, so a feature
// that ships a new action still counts in someone's year.
// ---------------------------------------------------------------------------

export const ACTIVITY_KINDS = ['write', 'review', 'discuss', 'curate'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export function activityKindFor(action: string): ActivityKind {
  // Comments first: 'merge-request.comment.created' is discussion, not review.
  if (action.includes('.comment.')) return 'discuss';
  if (action.startsWith('merge-request.')) return 'review';
  if (
    action.startsWith('document.') ||
    action.startsWith('revision.') ||
    action.startsWith('branch.') ||
    action.startsWith('import.') ||
    action.startsWith('attachment.')
  ) {
    return 'write';
  }
  // relations, glossary, projects, workflows, connectors, ai settings, and
  // whatever ships next: shaping the base rather than writing in it.
  return 'curate';
}

/** One day of one person's year. `date` is a calendar day, `YYYY-MM-DD` in UTC. */
export interface ActivityCalendarDay {
  date: string;
  total: number;
  byKind: Record<ActivityKind, number>;
}

// GET /v1/activity/calendar?workspaceId=&actor=&from=&to=
export interface ActivityCalendarResponse {
  workspaceId: string;
  /** users.id whose year this is, or 'dev' for the AUTH_MODE=none actor. */
  actor: string;
  /** Inclusive bounds, `YYYY-MM-DD`. */
  from: string;
  to: string;
  /** Only days with at least one entry; absent days are empty by construction. */
  days: ActivityCalendarDay[];
  total: number;
  byKind: Record<ActivityKind, number>;
  /** Busiest single day in the window — the ramp's top step is scaled to it. */
  busiestDay: number;
  /** Consecutive active days ending today (0 when today is empty). */
  currentStreak: number;
  /** Longest run of consecutive active days in the window. */
  longestStreak: number;
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
  /**
   * Deliver only to this user (docs/features/22).
   *
   * The bus is workspace-wide, so a notification published without this would
   * tell every peer in the workspace who is watching what. Both fan-out sites
   * — the SSE stream and the WS gateway — drop an event whose `userId` names
   * somebody else; an event without one stays a workspace broadcast.
   */
  userId?: string;
  /**
   * Why an addressed frame reached its recipient — a `NotificationReason`
   * (docs/features/22).
   *
   * Present only on `notification.created`, and only so a client can tell the
   * one reason worth interrupting somebody for (being named) from the rest,
   * which are news they will read when they next look at the bell. Without it
   * the client either toasts every watched-page edit or none of them.
   */
  reason?: string;
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
  // An agent's reply arriving in a comment that was posted empty. Distinct from
  // .created because the card is already on screen: the reader is watching a
  // placeholder, and a second .created would read as a second remark.
  'merge-request.comment.updated',
  'merge-request.comment.resolved',
  'merge-request.comment.deleted',
  'document.comment.created',
  'document.comment.updated',
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
  'agent.run.started',
  'agent.run.succeeded',
  'agent.run.failed',
  'connector.created',
  'connector.updated',
  'connector.deleted',
  'connector.run.started',
  'connector.run.succeeded',
  'connector.run.failed',
  // Staged tree import (docs/features/26). These carry the RUN id in
  // `subjectId`, unlike the four above, which carry the connector id — an item
  // event is only ever interesting against the run page it belongs to.
  'connector.run.paused',
  'connector.run.resumed',
  'connector.run.awaiting-review',
  'connector.item.staged',
  'connector.item.applied',
  'connector.item.reverted',
  'connector.item.failed',
  'connector.link.created',
  'connector.link.removed',
  // Carries a `userId` and reaches only that person (docs/features/22).
  // Deliberately outside every notification category, which is what stops a
  // notification from fanning out into another notification.
  'notification.created',
] as const;

// ---------------------------------------------------------------------------
// Notifications (docs/features/22)
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

export interface AssistantSuggestResponse {
  enabled: boolean;
  suggestion: string;
}

export interface AssistantRelatedResponse {
  results: SearchResult[];
  related?: RelatedDocumentResult[];
}

/**
 * A page in this workspace, cited by an answer.
 *
 * The name is historical — before web research (docs/features/25) this was the
 * only kind of source there was, and it is referenced by that name in enough
 * places that renaming it would be churn for its own sake. `kind` is optional
 * because rows persisted before feature 25 do not carry it; absent reads as
 * `'document'`, which `assistantSourceKey` and every consumer rely on.
 */
export interface AssistantAskSource {
  kind?: 'document';
  documentId: string;
  title: string;
  snippet?: string;
}

/**
 * A page on the open web, cited by an answer (docs/features/25).
 *
 * A separate interface rather than optional fields on the one above, because
 * the two are read differently at every single site: one is a RouterLink into
 * the workspace, the other leaves the product. A union makes TypeScript point
 * at each of those sites instead of letting `documentId` be silently undefined.
 *
 * Nothing here is a document — the page was fetched to settle one question and
 * left nothing behind. `fetchedAt` is what lets a citation say how old the
 * reading is, which is the whole difference between a live tool call and an
 * indexed page.
 */
export interface AssistantWebSource {
  kind: 'web';
  url: string;
  /** Host as it is shown to the reader — `docs.example.com`. */
  site: string;
  title: string;
  snippet?: string;
  /** ISO timestamp of the fetch or search that produced this citation. */
  fetchedAt?: string;
}

/** Anything an answer can cite. Discriminated by `kind`; absent means a document. */
export type AssistantSource = AssistantAskSource | AssistantWebSource;

/** True for a web citation — the one narrowing every consumer needs. */
export function isWebSource(source: AssistantSource): source is AssistantWebSource {
  return source.kind === 'web';
}

/**
 * Identity of a source, for de-duplicating a turn's citations. A document is
 * its id, a web page its URL; the two can never collide because a URL is not a
 * uuid, so one map holds both.
 */
export function assistantSourceKey(source: AssistantSource): string {
  return isWebSource(source) ? source.url : source.documentId;
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
  /**
   * Always documents, never web pages: this endpoint is the one model call
   * site with no agent behind it, so nothing can narrow what it is handed —
   * which is exactly why `definitions()` withholds the web tools from it
   * (docs/features/25). Typed narrowly so callers are not asked to handle a
   * case that cannot arise.
   */
  sources: AssistantAskSource[];
  /** Tool calls made by the harness, in order. */
  toolCalls?: AssistantToolCall[];
  /** Provider model that produced the answer. */
  model?: string;
}

// ---------------------------------------------------------------------------
// Assistant pane: persisted multi-turn chat threads with a documents sidebar
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
