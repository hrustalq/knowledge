import type { DocumentCategory, RelatedDocumentResult, SearchResult } from '@knowledge/contracts/documents';
import type { FactExtractor } from '@knowledge/contracts/graph';

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
  /**
   * The manual verification stamp (docs/features/38): who last said "this page
   * is right" and at which revision. Optional because only the detail route
   * fills it in — a tree node or a list row never needs it. `verification` is
   * the derived reading of the stamp against the head (`verificationStateFor`),
   * so the page can say "outdated" without anything having been written.
   */
  verifiedAt?: string | null;
  verifiedBy?: string | null;
  verifiedRevisionId?: string | null;
  verification?: SourceVerificationState;
  /**
   * Ownership, freshness and archive state (docs/features/39, issue #66).
   * Optional for the same reason the stamp is: the detail route and the
   * knowledge-health list fill them in, a tree node carries only what it draws
   * (`verification`, `archivedAt`).
   */
  ownerId?: string | null;
  /** Per-page review interval; `null` inherits the workspace default, `0` never expires. */
  reviewIntervalDays?: number | null;
  verificationExpiresAt?: string | null;
  /** A declared state (`requested` / `outdated`) with its note and where it came from. */
  verificationFlag?: VerificationFlag | null;
  verificationNote?: string | null;
  verificationSource?: VerificationSource | null;
  lastActivityAt?: string;
  /** Derived from `lastActivityAt` against the workspace's inactivity window. */
  inactive?: boolean;
  archivedAt?: string | null;
  archivedBy?: string | null;
  /**
   * The template this page was created from (issue #69): a template uuid or
   * `builtin:<key>`, and the version it was rendered at. Null for a page that
   * started blank or from an import — the true state of every older page.
   */
  templateRef?: string | null;
  templateVersion?: number | null;
  /**
   * The page is not open to the whole workspace: it, its project or an
   * ancestor is restricted (#76). Drawn as a lock.
   */
  restricted?: boolean;
  /**
   * The caller may not open this page, so only its id is real and `title` is
   * blank. Only ever an ancestor in a guest's breadcrumb trail (#76): a member
   * who can read a page can read everything above it.
   */
  hidden?: boolean;
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
  // Verifying, flagging, owning or archiving a page shapes the base without
  // writing in it (docs/features/39) — checked before the `document.` prefix
  // claims it as a write.
  if (CURATION_DOCUMENT_ACTIONS.has(action)) return 'curate';
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

/**
 * What a connected repository can tell us happened (docs/features/32).
 *
 * Its own array, spread into `KNOWN_EVENT_TYPES` below rather than typed out
 * there, because three consumers read exactly this subset and no other: the
 * GitHub webhook that maps a delivery onto one of these names, the workflow
 * trigger picker that offers them under their own heading, and the trigger
 * service that has to know a repo event resolves its page through a work-item
 * link rather than through `event.documentId`. A second hand-maintained copy is
 * how those three drift.
 *
 * `repo.` rather than `connector.repo.`: the existing `connector.*` events are
 * all about a sync run — our machinery — while these are about the far side,
 * and a trigger author reading a checkbox list should not have to know which
 * connector row delivered the news.
 */
export const REPO_EVENT_TYPES = [
  'repo.issue.opened',
  'repo.issue.closed',
  'repo.issue.reopened',
  'repo.issue.commented',
  'repo.issue.assigned',
  'repo.issue.labeled',
  'repo.pull-request.opened',
  'repo.pull-request.closed',
  /** Distinct from `.closed`: merged means the work landed (see the state vocabulary). */
  'repo.pull-request.merged',
  'repo.push',
  'repo.release.published',
] as const;
export type RepoEventType = (typeof REPO_EVENT_TYPES)[number];

/**
 * Event types the platform emits today — the tracking-config vocabulary
 * (`event.type` stays an open string for forward compat).
 *
 * This list is the subscription vocabulary, not the notification one: it backs
 * `LIVE_TRACKED_EVENTS`, the WS `subscribe` filter, and the workflow trigger
 * picker. `notificationCategoryFor` reads it separately and maps most of it to
 * no category on purpose.
 *
 * **It drifts in both directions and nothing catches it.** `publish()` is
 * unchecked and `KnowledgeEvent.type` is a plain string, so a type can be
 * declared here with no producer (four `connector.*` entries were, and were
 * removed) or produced with no declaration (29 were, and were added) — the
 * latter silently unsubscribable, since a filter can only match what is listed.
 * Audit with a grep for `publish(` and `record({ action:` before trusting it.
 * The real fix is an `EventRegistry` keyed on a closed union, which would make
 * both directions compile errors; see PONYTAIL-DEBT.md.
 */
export const KNOWN_EVENT_TYPES = [
  'document.created',
  'document.updated',
  // A person stamped the page as checked at its current head, or took the
  // stamp off (docs/features/38). The stamp itself lives on the document row;
  // whether it still holds is derived against the head at read time.
  'document.verified',
  'document.unverified',
  // Declared verification state, ownership and archive (docs/features/39,
  // issue #66). `verification-requested` and `outdated` reach the owner
  // directly; `expiring` / `expired` are the sweeper's, attributed to nobody.
  'document.verification-requested',
  'document.outdated',
  'document.verification-cleared',
  'document.verification-expiring',
  'document.verification-expired',
  'document.owner-changed',
  'document.archived',
  'document.unarchived',
  // A report against a page and what became of it (docs/features/38, phase
  // 3). `reported` reaches the page's last author directly and its watchers
  // by fan-out; the other three are feed rows.
  'knowledge-issue.reported',
  'knowledge-issue.proposed',
  'knowledge-issue.resolved',
  'knowledge-issue.dismissed',
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
  // An export finished or gave up (issue #77 phase 2c). Published by the
  // worker; reaches the person who asked for it through the run-owner rule.
  'export.completed',
  'export.failed',
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
  // A trigger started a run (#70): `subjectId` is the run, `documentId` the
  // page it is about, when it is about one.
  'agent.trigger.fired',
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
  'connector.item.reverted',
  'connector.link.removed',
  // Configuration changes. These are TRACKABLE but not notifiable: they map to
  // no `notificationCategoryFor` category, which is correct — an admin editing
  // a provider is something a dashboard may watch live, not something anyone
  // should find in an inbox.
  'ai.settings.updated',
  'ai.provider.created',
  'ai.provider.updated',
  'ai.provider.deleted',
  'ai.skill.created',
  'ai.skill.updated',
  'ai.skill.deleted',
  'ai.plugin.created',
  'ai.plugin.updated',
  'ai.plugin.deleted',
  'ai.agent.created',
  'ai.agent.updated',
  'ai.agent.deleted',
  // An agent override reset back to its built-in default (docs/features/20).
  'ai.agent.reset',
  'ai.agent.trigger.created',
  'ai.agent.trigger.updated',
  'ai.agent.trigger.deleted',
  // A recipe's schedule and triggers written, disabled (#70).
  'ai.agent.recipe.applied',
  'ai.sourcePolicy.created',
  'ai.sourcePolicy.updated',
  'ai.sourcePolicy.deleted',
  // Workflow DEFINITION lifecycle — distinct from the `workflow-run.*` above,
  // which is one execution of one.
  'workflow.created',
  'workflow.updated',
  'workflow.deleted',
  // Page templates (issue #69). Trackable, not notifiable — like the AI
  // settings above, a template edit is configuration, not news.
  'template.created',
  'template.updated',
  'template.archived',
  'template.unarchived',
  'template.reset',
  'glossary.term.created',
  'glossary.term.updated',
  'glossary.term.deleted',
  // Access requests (#76, phase 5). `requested` reaches the node's managers and
  // workspace admins; the rest reach the requester. `granted` is a grant made
  // to a person directly from the access dialog.
  'access.requested',
  'access.approved',
  'access.denied',
  'access.cancelled',
  'access.expired',
  'access.granted',
  // A restriction, a grant or a group's membership changed (#76). Carries no
  // page and no names: it tells live clients to drop what they cached about
  // who sees what and refetch the tree and search.
  'acl.changed',
  'attachment.created',
  'attachment.deleted',
  // A turn in progress, for a client rendering the assistant's own work
  // (docs/features/09). High-frequency: a tool-heavy turn emits several pairs.
  'assistant.turn.started',
  'assistant.turn.finished',
  'assistant.tool-call.started',
  'assistant.tool-call.finished',
  // Carries a `userId` and reaches only that person (docs/features/22).
  // Deliberately outside every notification category, which is what stops a
  // notification from fanning out into another notification.
  'notification.created',
  ...REPO_EVENT_TYPES,
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
export interface AssistantAskSource extends SourceProvenance {
  kind?: 'document';
  documentId: string;
  title: string;
  snippet?: string;
  /**
   * The per-turn label the model cites this page by — `S1`, `S2`, … — assigned
   * in the order sources were gathered and shown to the model inside every
   * tool result (docs/features/38). A sentence in the answer ending in `[S2]`
   * rests on this source. Optional: rows persisted before the feature carry
   * none, and then the message simply has no sentence-level citations.
   */
  cite?: string;
}

// ---------------------------------------------------------------------------
// Answer provenance and confidence (docs/features/38, issue #67 phase 1)
// ---------------------------------------------------------------------------

/**
 * What a page's verification reads as right now (docs/features/38 + 39).
 *
 * Derived, never stored (house classifier rule). The row carries a stamp
 * (`verified_revision_id`, `verification_expires_at`) and at most one declared
 * flag (`verification_flag`); this is both read against the head and the clock:
 *
 * - `outdated`   — declared wrong: a merged pull request the sentinel tied to the
 *                  page, a person, or an agent over MCP. Strongest, because it
 *                  is a statement about the content, not about the stamp.
 * - `flagged`    — an open knowledge issue (docs/features/38, phase 3).
 * - `requested`  — somebody asked for a check (a person, a drift report, MCP).
 * - `unverified` — never stamped.
 * - `edited`     — stamped at an older revision: the head moved, nobody has
 *                  vouched for it since. Not `outdated`: an edit after a check
 *                  is usually a fix, and ranking must not punish it like a
 *                  page known to be wrong.
 * - `expired`    — stamped at the head, but `verification_expires_at` passed.
 * - `verified`   — stamped at the head, inside its interval.
 *
 * A new revision, a passing deadline or a closed report each change the answer
 * with no write to the document row, which is what lets search, the dashboard,
 * the sweeper and the page agree without a job keeping them in step.
 */
export const SOURCE_VERIFICATION_STATES = [
  'verified',
  'expired',
  'edited',
  'requested',
  'outdated',
  'flagged',
  'unverified',
] as const;
export type SourceVerificationState = (typeof SOURCE_VERIFICATION_STATES)[number];

/** The two states a person or an agent *declares*; everything else is derived. */
export const VERIFICATION_FLAGS = ['requested', 'outdated'] as const;
export type VerificationFlag = (typeof VERIFICATION_FLAGS)[number];

/** Who set the flag. `drift` and `curator` are the agents of docs/features/35 and 20. */
export const VERIFICATION_SOURCE_KINDS = ['person', 'drift', 'curator', 'mcp'] as const;
export type VerificationSourceKind = (typeof VERIFICATION_SOURCE_KINDS)[number];

export interface VerificationSource {
  kind: VerificationSourceKind;
  /** users.id of the person, or the run owner the agent acted for. */
  by?: string;
  /** The agent run that produced the finding, when an agent set it. */
  runId?: string;
  /** The pull request a drift finding came from. */
  url?: string;
  /** ISO timestamp. */
  at: string;
}

/** Everything the predicate reads off a document row. All optional: a pre-#66 caller passes the stamp alone. */
export interface VerificationInput {
  verifiedRevisionId: string | null | undefined;
  verificationExpiresAt?: Date | string | null;
  verificationFlag?: VerificationFlag | string | null;
}

export function verificationStateFor(
  doc: VerificationInput,
  headRevisionId: string | null | undefined,
  openIssueCount: number,
  now: Date = new Date(),
): SourceVerificationState {
  if (doc.verificationFlag === 'outdated') return 'outdated';
  if (openIssueCount > 0) return 'flagged';
  if (doc.verificationFlag === 'requested') return 'requested';
  if (!doc.verifiedRevisionId) return 'unverified';
  if (!headRevisionId || doc.verifiedRevisionId !== headRevisionId) return 'edited';
  const expires = doc.verificationExpiresAt ? new Date(doc.verificationExpiresAt) : null;
  if (expires && expires.getTime() <= now.getTime()) return 'expired';
  return 'verified';
}

/** States under which the stamp no longer vouches for the page a reader opens. */
export function verificationIsStale(state: SourceVerificationState): boolean {
  return state === 'edited' || state === 'expired' || state === 'outdated';
}

// ---------------------------------------------------------------------------
// Page trust: freshness, ownership and ranking weight (docs/features/39, #66)
// ---------------------------------------------------------------------------

/**
 * No qualifying activity inside the window. Only writes, comments and
 * verification count (`FRESHNESS_ACTIONS`): read analytics is another
 * milestone, so a page read daily but never touched looks inactive here.
 */
export function isInactive(lastActivityAt: Date | string | null | undefined, inactiveAfterDays: number, now: Date = new Date()): boolean {
  if (!lastActivityAt || inactiveAfterDays <= 0) return false;
  const at = new Date(lastActivityAt).getTime();
  return now.getTime() - at > inactiveAfterDays * 86_400_000;
}

/**
 * The activity actions that mean "somebody touched this page", bumping
 * `documents.last_activity_at`. Read by `ActivityService.record` so a new call
 * site cannot forget to bump it, and by the migration's backfill.
 */
export const FRESHNESS_ACTIONS: ReadonlySet<string> = new Set([
  'revision.finalized',
  'merge-request.merged',
  'document.comment.created',
  'document.verified',
]);

/** Actions `activityKindFor` files under `curate` although they carry the `document.` prefix. */
export const CURATION_DOCUMENT_ACTIONS: ReadonlySet<string> = new Set([
  'document.verified',
  'document.unverified',
  'document.verification-requested',
  'document.outdated',
  'document.verification-cleared',
  'document.verification-expiring',
  'document.verification-expired',
  'document.owner-changed',
  'document.archived',
  'document.unarchived',
]);

/**
 * The multiplicative weight a search hit's fused score takes from its page's
 * state. Multiplicative so it works for RRF, cosine-only and max-normalized
 * BM25 scores alike. The numbers are guesses to be tuned with `make backtest`;
 * they are exported constants so tuning them needs no migration. A verified
 * page must not beat a clearly more relevant unverified one, which bounds the
 * top factor near 1.
 */
export const TRUST_WEIGHTS: Readonly<Record<SourceVerificationState, number>> & { readonly inactive: number } = {
  verified: 1.15,
  unverified: 1,
  requested: 1,
  edited: 1,
  expired: 0.85,
  flagged: 0.85,
  outdated: 0.5,
  /** Applied on top of the state factor. */
  inactive: 0.9,
};

export function trustWeight(state: SourceVerificationState, inactive: boolean): number {
  return TRUST_WEIGHTS[state] * (inactive ? TRUST_WEIGHTS.inactive : 1);
}

/** What a search hit says about how much to trust its page. */
export interface DocumentTrust {
  status: SourceVerificationState;
  verifiedAt?: string | null;
  expiresAt?: string | null;
  ownerId?: string | null;
  inactive: boolean;
}

/**
 * The knowledge-health dashboard's filters (docs/features/40). `stale` is the
 * union of expired, outdated and inactive — the "needs attention" view.
 * `whereForHealthFilter` in the API is this list's SQL inverse, so a filter
 * here with no clause there fails the spec rather than returning everything.
 */
export const HEALTH_FILTERS = [
  'stale',
  'unowned',
  'empty',
  'expired',
  'edited',
  'outdated',
  'requested',
  'flagged',
  'inactive',
  'archived',
] as const;
export type HealthFilter = (typeof HEALTH_FILTERS)[number];

export const HEALTH_BULK_ACTIONS = ['verify', 'request', 'outdated', 'clear', 'reassign', 'archive', 'unarchive'] as const;
export type HealthBulkAction = (typeof HEALTH_BULK_ACTIONS)[number];
/** Bulk actions that need `admin`: an archive sweep across somebody else's pages is an admin's act. */
export const HEALTH_ADMIN_BULK_ACTIONS: readonly HealthBulkAction[] = ['archive', 'unarchive'];
export const HEALTH_BULK_MAX_IDS = 200;
export const VERIFICATION_NOTE_MAX_CHARS = 1000;

/** One row of the dashboard: a page and everything a curator decides on. */
export interface KnowledgeHealthRow {
  documentId: string;
  projectId: string;
  title: string;
  /** Ancestor titles root-first, " / "-joined; empty for a root. */
  breadcrumb: string;
  status: SourceVerificationState;
  ownerId: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
  lastActivityAt: string;
  inactive: boolean;
  /** Null while the head's body length is unknown (legacy revisions catch up in the sweeper). */
  empty: boolean | null;
  archivedAt: string | null;
  childCount: number;
  verificationFlag: VerificationFlag | null;
  verificationNote: string | null;
}

// GET /v1/knowledge-health?workspaceId=&projectId=&filter=&ownerId=&q=&cursor=&limit=
export interface KnowledgeHealthListResponse {
  workspaceId: string;
  rows: KnowledgeHealthRow[];
  nextCursor: string | null;
}

// GET /v1/knowledge-health/summary?workspaceId=&projectId=
export interface KnowledgeHealthSummaryResponse {
  workspaceId: string;
  total: number;
  counts: Record<HealthFilter, number>;
}

// POST /v1/knowledge-health/bulk
export interface KnowledgeHealthBulkResult {
  documentId: string;
  ok: boolean;
  /** A short code when `ok` is false: `archived`, `no-head`, `not-found`. */
  error?: string;
}
export interface KnowledgeHealthBulkResponse {
  action: HealthBulkAction;
  results: KnowledgeHealthBulkResult[];
}

/**
 * Per-workspace freshness settings (docs/features/40) — a sparse override of the
 * `VERIFICATION_*` / `PAGE_INACTIVE_AFTER_DAYS` / `SEARCH_TRUST_RANKING` env
 * block. `effective` is what applies; `override` is what the row says, `null`
 * meaning "inherit", so the UI can show both and a silent clamp cannot lie.
 */
export interface KnowledgeHealthSettingsValues {
  reviewIntervalDays: number;
  remindBeforeDays: number;
  inactiveAfterDays: number;
  emptyMaxChars: number;
  trustRanking: boolean;
}
export type KnowledgeHealthSettingsOverride = { [K in keyof KnowledgeHealthSettingsValues]: KnowledgeHealthSettingsValues[K] | null };

// POST /v1/documents/:id/archive | /unarchive
export interface ArchiveDocumentResponse {
  documentId: string;
  archivedAt: string | null;
  /** Rows the one statement touched: the page and, by default, its subtree. */
  affected: number;
}

// GET/PATCH /v1/knowledge-health/settings?workspaceId=
export interface KnowledgeHealthSettingsResponse {
  workspaceId: string;
  effective: KnowledgeHealthSettingsValues;
  override: KnowledgeHealthSettingsOverride;
  defaults: KnowledgeHealthSettingsValues;
}

/**
 * What a reader needs to decide how much to trust one cited page: which
 * revision was read, who wrote it, when it last changed, whether anyone has
 * checked it, and what kind of fact it is. Every field is optional because
 * each is resolved from a different store at the end of the turn, and an answer
 * must still render when one of those lookups has nothing to say.
 *
 * Shared between an assistant citation and an MCP search hit, so an agent over
 * MCP reads the same freshness a person sees in the chat.
 */
export interface SourceProvenance {
  revisionId?: string;
  revisionNumber?: number;
  /** The chunk the hit came from, when it came from search. */
  chunkId?: string;
  /** Heading trail of that chunk, root first — enough to anchor a link to a section. */
  headingPath?: string[];
  authorId?: string;
  authorName?: string;
  /** ISO timestamp the head revision was finalized — the page's freshness. */
  changedAt?: string;
  verification?: SourceVerificationState;
  verifiedAt?: string;
  verifiedByName?: string;
  /**
   * How this fact reached the answer. Page text read directly is `explicit`;
   * a page reached through a graph edge carries that edge's extractor.
   */
  factClass?: FactExtractor;
  /** Retrieval score of the best chunk, 0..1, when the source came from search. */
  score?: number;
}

/**
 * One sentence of the answer and the sources it rests on. `start`/`end` are
 * character offsets into the persisted answer text; `cites` are source labels
 * (`S1`…) that always resolve to a source on the same message — unknown labels
 * are stripped before the message is stored.
 */
export interface AnswerCitation {
  start: number;
  end: number;
  cites: string[];
}

export const ANSWER_CONFIDENCE_LEVELS = ['high', 'medium', 'low', 'none'] as const;
export type AnswerConfidenceLevel = (typeof ANSWER_CONFIDENCE_LEVELS)[number];

/**
 * Why the confidence is what it is. Closed so the web can translate each one
 * into a sentence; `value` is the signal's magnitude (a count or a ratio), not
 * the penalty, so the UI can say "3 of 7 sentences cite nothing".
 */
export const ANSWER_CONFIDENCE_REASONS = [
  'no-sources',
  'uncited-sentences',
  'stale-sources',
  'inferred-only',
  'unknown-citation',
  'budget-exhausted',
  'tool-errors',
  'low-retrieval-score',
  'flagged-sources',
  'verified-sources',
] as const;
export type AnswerConfidenceReasonKey = (typeof ANSWER_CONFIDENCE_REASONS)[number];

export interface AnswerConfidenceReason {
  key: AnswerConfidenceReasonKey;
  value: number;
}

export interface AnswerConfidence {
  level: AnswerConfidenceLevel;
  /** 0..1, the number the level was cut from. */
  score: number;
  reasons: AnswerConfidenceReason[];
}

/** The observable facts about one finished answer that `assessAnswer` reads. */
export interface AnswerSignals {
  /** Sentences in the answer outside code blocks. */
  sentences: number;
  /** Of those, how many end in at least one resolvable citation. */
  citedSentences: number;
  /** Distinct sources the turn gathered. */
  sources: number;
  /** Distinct sources at least one sentence cites. */
  citedSources: number;
  /** Markers the model wrote that named no gathered source (stripped). */
  unknownCitations: number;
  /** Best retrieval score among the sources, when any came from search. */
  maxScore: number | null;
  /** Cited sources whose head changed longer ago than the stale threshold, or whose stamp is outdated. */
  staleSources: number;
  /** Cited sources with an open report. */
  flaggedSources: number;
  /** Cited sources whose stamp holds at the head. */
  verifiedSources: number;
  /** Every cited source reached the answer through an inferred graph edge only. */
  inferredOnly: boolean;
  /** Tool calls that returned an error this turn. */
  toolErrors: number;
  /** The turn ran out of tool budget or rounds before it finished reading. */
  budgetExhausted: boolean;
}

/**
 * The weights, named so a reader of a confidence badge can be pointed at the
 * number that produced it, and so the backtest can re-tune them against the
 * feedback dataset (issue #67 phase 5) without finding them inline.
 *
 * Deliberately no model self-assessment: the score is a function of things the
 * harness observed, so it cannot be talked up by the answer it describes.
 */
export const ANSWER_CONFIDENCE_WEIGHTS = {
  /** Penalty at zero citation coverage, scaled linearly by the uncited share. */
  coverage: 0.45,
  /** Per unknown label, capped. */
  unknownCitation: 0.1,
  unknownCitationCap: 0.3,
  /** Scaled by the stale share of cited sources. */
  stale: 0.2,
  /** Any cited page with an open report: a reader was already told something is wrong. */
  flagged: 0.3,
  inferredOnly: 0.3,
  /** Per failed tool call, capped. */
  toolError: 0.1,
  toolErrorCap: 0.2,
  budgetExhausted: 0.15,
  /** Applied when the best retrieval score is under `lowScoreBelow`. */
  lowScore: 0.2,
  lowScoreBelow: 0.35,
  /** Bonus when every cited source is verified at its head. */
  verified: 0.1,
  /** Level cuts on the final score. */
  high: 0.75,
  medium: 0.5,
} as const;

/**
 * Confidence from observable signals — one pure function the API stores with,
 * the web explains with and the backtest recomputes with, so three consumers
 * cannot disagree about what `medium` means.
 *
 * `none` is reserved for an answer with no sources at all: whatever the model
 * wrote, nothing in the workspace backs it. Everything else starts at 1 and
 * loses points for what is missing, so an answer that cites every sentence
 * from fresh, verified pages is `high` and one that cites nothing is `low`.
 */
export function assessAnswer(s: AnswerSignals): AnswerConfidence {
  const W = ANSWER_CONFIDENCE_WEIGHTS;
  const reasons: AnswerConfidenceReason[] = [];
  if (s.sources <= 0) {
    return { level: 'none', score: 0, reasons: [{ key: 'no-sources', value: 0 }] };
  }
  let score = 1;
  const round = (n: number) => Math.round(n * 1000) / 1000;

  if (s.sentences > 0) {
    const uncited = Math.max(0, s.sentences - s.citedSentences);
    if (uncited > 0) {
      score -= W.coverage * (uncited / s.sentences);
      reasons.push({ key: 'uncited-sentences', value: uncited });
    }
  } else if (s.citedSentences === 0) {
    // An answer with no prose sentences (a bare code block, a table) cites
    // nothing and is treated as fully uncited.
    score -= W.coverage;
    reasons.push({ key: 'uncited-sentences', value: 0 });
  }
  if (s.unknownCitations > 0) {
    score -= Math.min(W.unknownCitationCap, W.unknownCitation * s.unknownCitations);
    reasons.push({ key: 'unknown-citation', value: s.unknownCitations });
  }
  const citedBase = Math.max(1, s.citedSources);
  if (s.staleSources > 0) {
    score -= W.stale * Math.min(1, s.staleSources / citedBase);
    reasons.push({ key: 'stale-sources', value: s.staleSources });
  }
  if (s.flaggedSources > 0) {
    score -= W.flagged;
    reasons.push({ key: 'flagged-sources', value: s.flaggedSources });
  }
  if (s.inferredOnly) {
    score -= W.inferredOnly;
    reasons.push({ key: 'inferred-only', value: 1 });
  }
  if (s.toolErrors > 0) {
    score -= Math.min(W.toolErrorCap, W.toolError * s.toolErrors);
    reasons.push({ key: 'tool-errors', value: s.toolErrors });
  }
  if (s.budgetExhausted) {
    score -= W.budgetExhausted;
    reasons.push({ key: 'budget-exhausted', value: 1 });
  }
  if (s.maxScore !== null && s.maxScore < W.lowScoreBelow) {
    score -= W.lowScore;
    reasons.push({ key: 'low-retrieval-score', value: round(s.maxScore) });
  }
  if (s.citedSources > 0 && s.verifiedSources >= s.citedSources && s.flaggedSources === 0) {
    score += W.verified;
    reasons.push({ key: 'verified-sources', value: s.verifiedSources });
  }
  score = round(Math.min(1, Math.max(0, score)));
  const level: AnswerConfidenceLevel = score >= W.high ? 'high' : score >= W.medium ? 'medium' : 'low';
  return { level, score, reasons };
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
  /** Same per-turn label scheme as a page source, so one answer numbers all its sources in one series. */
  cite?: string;
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
  /** Sentence spans of `answer` and the `cite` labels each rests on (docs/features/38). */
  citations?: AnswerCitation[];
  /** Derived from the turn's observable signals; null when the assistant is disabled. */
  confidence?: AnswerConfidence | null;
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
