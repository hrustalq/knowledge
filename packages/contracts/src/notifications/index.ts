import { KNOWN_EVENT_TYPES } from '@knowledge/contracts/core';

//
// The event bus and the activity feed are both workspace-wide broadcasts: they
// answer "what happened here", never "what happened that concerns me". These
// types are the per-person layer — a durable inbox, plus a `watch` relationship
// so a page or a whole project can be followed.
// ---------------------------------------------------------------------------

/** What a person can watch. A project subscription catches every page inside it. */
export const NOTIFICATION_SUBJECT_TYPES = ['document', 'merge-request', 'project'] as const;
export type NotificationSubjectType = (typeof NOTIFICATION_SUBJECT_TYPES)[number];

/**
 * Why a row reached this person — the inbox's second line, and the thing that
 * decides which notification survives coalescing.
 *
 * Ordered weakest to strongest on purpose: `notificationReasonRank` reads this
 * array, so inserting a reason in the right place is all it takes to rank it.
 */
export const NOTIFICATION_REASONS = [
  'watching',
  'participant',
  'author',
  'assigned',
  'review-requested',
  'mention',
] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

/** How strongly a reason claims a coalesced row. Higher wins. */
export function notificationReasonRank(reason: string): number {
  const i = (NOTIFICATION_REASONS as readonly string[]).indexOf(reason);
  // An unknown reason ranks below every known one rather than above: a future
  // reason must not silently outrank `mention`, the one a person must not miss.
  return i < 0 ? -1 : i;
}

/**
 * The inbox's grouping, and the unit a person can switch off.
 *
 * Cut by what somebody would actually mute rather than by which subsystem
 * emitted the event: `job` covers a workflow run, an agent run, an import and a
 * connector sync because they are one thing to the reader — background work
 * they started, now finished.
 */
export const NOTIFICATION_CATEGORIES = ['mention', 'review', 'comment', 'document', 'job'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

/**
 * Which category an event type belongs to, or `null` when it is not worth an
 * inbox row.
 *
 * This is the gate that runs before any database work, so the great majority of
 * events (every revision lifecycle step, every settings write, every
 * `connector.link.*`) cost one array lookup and nothing else.
 *
 * Deliberately NOT stored on `notifications`, for the reason `activityKindFor`
 * is not stored on `activity_log`: the event type is the durable fact and the
 * category is a reading of it, which may be re-cut later without a migration.
 * Category filtering still happens in SQL — see `typesForCategory`.
 *
 * `mention` is absent here because a mention is not a type: it is the same
 * `*.comment.created` event, addressed to a named person rather than broadcast
 * to a subject's watchers, so it is carried by the row's `reason`.
 */
export function notificationCategoryFor(type: string): NotificationCategory | null {
  // Comments before the merge-request prefix: a remark on an MR is discussion,
  // not review — the split `activityKindFor` already makes.
  if (type.endsWith('.comment.created') || type.endsWith('.comment.updated')) return 'comment';
  if (NOTIFIED_REVIEW_TYPES.includes(type)) return 'review';
  if (NOTIFIED_DOCUMENT_TYPES.includes(type)) return 'document';
  if (NOTIFIED_JOB_TYPES.includes(type)) return 'job';
  return null;
}

/**
 * `revision.finalized`, not `revision.indexed`, is what "the page changed"
 * means here: finalizing carries the author as its actor, while the worker's
 * indexing events carry none — so notifying on those would tell authors about
 * their own edits, which is the one thing an inbox must not do.
 */
const NOTIFIED_DOCUMENT_TYPES: readonly string[] = ['revision.finalized', 'document.updated'];

const NOTIFIED_REVIEW_TYPES: readonly string[] = [
  'merge-request.created',
  'merge-request.approved',
  'merge-request.merged',
  'merge-request.closed',
  'merge-request.reopened',
  'merge-request.review-requested',
];

/** Work somebody started that has now finished — or failed, which matters more. */
const NOTIFIED_JOB_TYPES: readonly string[] = [
  'workflow-run.completed',
  'workflow-run.failed',
  'workflow-node.awaiting-review',
  'agent.run.succeeded',
  'agent.run.failed',
  'import.parsed',
  'import.failed',
  'connector.run.failed',
  // "Your pull is staged and waiting on you" — the `workflow-node.awaiting-review`
  // role. The per-item events are deliberately absent: a 500-page space would
  // otherwise be 500 inbox rows for one act.
  'connector.run.awaiting-review',
];

/**
 * The event types a category covers, for filtering in SQL.
 *
 * The inverse of `notificationCategoryFor` over the closed `KNOWN_EVENT_TYPES`
 * vocabulary, which is what lets the list endpoint push a category filter into
 * `WHERE type IN (…)` instead of over-fetching and classifying in Node. A type
 * that ships later without joining that list simply will not match a category
 * filter — the same forward-compatibility trade the open `event.type` makes.
 */
export function typesForCategory(category: NotificationCategory): string[] {
  return KNOWN_EVENT_TYPES.filter((type) => notificationCategoryFor(type) === category);
}

/**
 * The category a *stored row* belongs to, which is not always the category its
 * event type belongs to.
 *
 * A directed notification is filed by its reason, because the event it rode in
 * on does not describe it: a mention arrives as an ordinary
 * `*.comment.created`, and being handed a merge request arrives as
 * `merge-request.updated` — a type that is deliberately not notifiable at all,
 * since a title edit is not news. Only the reason knows which of those was
 * addressed to somebody.
 *
 * Without this split, muting `comment` would silently mute mentions — the one
 * notification a person must not lose — an assignment would fall out of every
 * category badge while still counting toward the total, and the tab a row is
 * filed under would disagree with the tab that counted it.
 */
export function notificationRowCategory(type: string, reason: string): NotificationCategory | null {
  const directed = DIRECTED_REASON_CATEGORY[reason];
  return directed ?? notificationCategoryFor(type);
}

/** Reasons that carry their own category, overriding the event type's. */
const DIRECTED_REASON_CATEGORY: Record<string, NotificationCategory | undefined> = {
  mention: 'mention',
  assigned: 'review',
  'review-requested': 'review',
};

/** One inbox row. */
export interface NotificationEntry {
  id: string;
  workspaceId: string;
  /** The KnowledgeEvent type that produced this row. */
  type: string;
  /** Derived from `type`, never stored — see `notificationCategoryFor`. */
  category: NotificationCategory | null;
  reason: NotificationReason | string;
  /** users.id, or 'dev'. Null for work no person triggered. */
  actor: string | null;
  documentId: string | null;
  subjectType: NotificationSubjectType | null;
  subjectId: string | null;
  /**
   * The page or merge request title as it read when this happened. Denormalized
   * on purpose: an inbox that rewrote itself when a page was renamed would be
   * answering a different question than "what happened while I was away".
   */
  title: string | null;
  /** Render extras — `count` for a coalesced row, branch names, error text. */
  metadata: Record<string, unknown>;
  /** ISO timestamp, or null while unread. */
  readAt: string | null;
  createdAt: string;
}

// GET /v1/notifications?workspaceId=&unread=&category=&limit=&cursor=
export interface ListNotificationsResponse {
  workspaceId: string;
  entries: NotificationEntry[];
  nextCursor: string | null;
  /** Unread rows in this workspace, ignoring the current filters — the bell's badge. */
  unreadCount: number;
  /** Unread per category under the same scope, for the tab badges (the MR-list precedent). */
  counts: Record<NotificationCategory, number>;
}

// GET /v1/notifications/unread-count?workspaceId=
export interface NotificationUnreadCountResponse {
  workspaceId: string;
  count: number;
  counts: Record<NotificationCategory, number>;
}

export interface MarkNotificationsReadResponse {
  updated: number;
  unreadCount: number;
}

/**
 * Watch state for one subject.
 *
 * `muted` is a stored row rather than the absence of one: auto-subscription
 * would otherwise re-add a person the moment they commented again, so an
 * explicit "stop telling me about this" has to be recorded as a fact.
 * `default` is the absence — no row, so involvement may subscribe you later.
 */
export const SUBSCRIPTION_STATES = ['watching', 'muted', 'default'] as const;
export type SubscriptionState = (typeof SUBSCRIPTION_STATES)[number];

export interface NotificationSubscriptionEntry {
  /** The row's own id — what `nextCursor` points at, as on every paged list here. */
  id: string;
  subjectType: NotificationSubjectType;
  subjectId: string;
  /**
   * What the subject is called — a page or merge-request title, a project name.
   *
   * Null only when the subject has since been deleted, which is the one case
   * where there is nothing to name and the id is all that is left. The list is
   * a list of things somebody chose to follow; identifying them by the first
   * eight characters of a UUID asked the reader to recognise their own pages by
   * hash.
   */
  title: string | null;
  state: Exclude<SubscriptionState, 'default'>;
  /** How the row appeared: 'manual' when a person pressed Watch, else the involvement that added it. */
  reason: string;
  createdAt: string;
}

// GET /v1/notifications/subscriptions?workspaceId=&subjectType=&subjectId=&limit=&cursor=
export interface ListNotificationSubscriptionsResponse {
  workspaceId: string;
  subscriptions: NotificationSubscriptionEntry[];
  /**
   * Null at the end of the list.
   *
   * Somebody who watches a page per working day crosses a thousand rows in four
   * years, and the settings page drew every one of them. This is the same
   * cursor the activity feed and the inbox use — the last row's id, opaque to
   * the caller.
   */
  nextCursor: string | null;
}


/**
 * Per-person, per-workspace preferences — a sparse override of the code
 * defaults (the `ai_settings` relationship to the `ASSISTANT_*` env vars): an
 * empty table means everybody gets everything, so the feature ships switched on
 * without a migration having to write a row per member.
 */
export interface NotificationPreferences {
  workspaceId: string;
  /** Categories switched off. A muted category suppresses even a directed notification. */
  mutedCategories: NotificationCategory[];
  /** Commenting on something subscribes you to it (GitHub's default). */
  autoWatchOnComment: boolean;
}


// ---------------------------------------------------------------------------
// Live tracked-entity updates over WebSocket (/v1/events/ws)
