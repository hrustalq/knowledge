// Chat bots (issue #71): a workspace answering in a messenger.
//
// Buildless package: no enums, no relative cross-file imports (see
// packages/contracts/src/index.ts).
import type { Locale } from '@knowledge/contracts/core';

/**
 * The messengers a workspace can connect. Telegram only, for now: Slack and
 * Teams join this list in the release that ships their adapter, never before —
 * a closed vocabulary must not promise a value the code never emits, and the
 * setup form, the DTO guard and the adapter registry all read this one list.
 */
export const CHAT_PLATFORM_KINDS = ['telegram'] as const;
export type ChatPlatformKind = (typeof CHAT_PLATFORM_KINDS)[number];

/**
 * When the bot answers in a bound group. `mention` is the default because a
 * group is a conversation between people, and a bot that answers every message
 * in it is a bot somebody removes.
 */
export const CHAT_ANSWER_MODES = ['mention', 'all', 'off'] as const;
export type ChatAnswerMode = (typeof CHAT_ANSWER_MODES)[number];

/** The pending row is the claim: one per inbound message, filled in or failed. */
export const CHAT_ANSWER_STATUSES = ['pending', 'answered', 'failed'] as const;
export type ChatAnswerStatus = (typeof CHAT_ANSWER_STATUSES)[number];

/**
 * What a conversation can be saved as (phase 2): a page draft behind a merge
 * request, or a glossary term proposed switched off.
 */
export const CHAT_CAPTURE_KINDS = ['page', 'glossary-term'] as const;
export type ChatCaptureKind = (typeof CHAT_CAPTURE_KINDS)[number];

/**
 * A capture is drafted and published in one continuation, so there is no
 * "drafted" stage between the two to promise.
 */
export const CHAT_CAPTURE_STATUSES = ['pending', 'published', 'failed'] as const;
export type ChatCaptureStatus = (typeof CHAT_CAPTURE_STATUSES)[number];

/**
 * What a bound group can be told about (phase 3). Only titles and links ever
 * reach the group: its members need not be workspace members, and the link
 * enforces the ACL on click.
 */
export const CHAT_SUBSCRIPTION_EVENT_KINDS = [
  'page-published',
  'page-updated',
  'merge-request-opened',
  'merge-request-merged',
] as const;
export type ChatSubscriptionEventKind = (typeof CHAT_SUBSCRIPTION_EVENT_KINDS)[number];

/** `instant` is every tick; `digest` is one message per `digestMinutes`. */
export const CHAT_SUBSCRIPTION_DELIVERIES = ['instant', 'digest'] as const;
export type ChatSubscriptionDelivery = (typeof CHAT_SUBSCRIPTION_DELIVERIES)[number];

/** The digest windows the settings form offers and the DTO accepts: hourly, every 4 hours, daily. */
export const CHAT_DIGEST_MINUTES = [60, 240, 1440] as const;
export type ChatDigestMinutes = (typeof CHAT_DIGEST_MINUTES)[number];

/**
 * The `activity_log` action each kind is read from. A page's two kinds share
 * one action: whether a finalized revision *published* the page or *updated*
 * it depends on the revision (default branch, first one there), which only the
 * sweeper can look up — see `chatEventKindFor`.
 */
const CHAT_EVENT_ACTIONS: Record<ChatSubscriptionEventKind, string> = {
  'page-published': 'revision.finalized',
  'page-updated': 'revision.finalized',
  'merge-request-opened': 'merge-request.created',
  'merge-request-merged': 'merge-request.merged',
};

/**
 * The actions a subscription's kinds are read from — the inverse of
 * `chatEventKindFor`, so the sweeper filters in SQL (`action IN (…)`) rather
 * than reading every row and classifying in Node.
 */
export function chatActionsFor(kinds: readonly ChatSubscriptionEventKind[]): string[] {
  return [...new Set(kinds.map((k) => CHAT_EVENT_ACTIONS[k]))];
}

/**
 * Which kind an activity row is, or null when it is none — derived, never
 * stored, for the reason `activityKindFor` is not: the action is the durable
 * fact and the kind is a reading of it.
 *
 * A finalized revision counts only on the page's default branch — a draft on a
 * review branch is nobody's news until it merges — and it *publishes* the page
 * when it is the first revision there, which is also how a merge into an empty
 * page (a chat-saved draft, say) reads.
 */
export function chatEventKindFor(
  action: string,
  revision: { onDefaultBranch: boolean; first: boolean } | null,
): ChatSubscriptionEventKind | null {
  if (action === 'merge-request.created') return 'merge-request-opened';
  if (action === 'merge-request.merged') return 'merge-request-merged';
  if (action === 'revision.finalized' && revision?.onDefaultBranch) {
    return revision.first ? 'page-published' : 'page-updated';
  }
  return null;
}

/**
 * A bot as /settings/chat lists it. The token is write-only: `credentialHint`
 * is all the API ever returns of it.
 */
export interface ChatIntegrationSummary {
  id: string;
  workspaceId: string;
  kind: ChatPlatformKind;
  name: string;
  enabled: boolean;
  credentialHint: string | null;
  /** Read from the platform when the integration is saved or tested. */
  botUsername: string | null;
  /** null = the researcher. */
  defaultAgentKey: string | null;
  locale: Locale;
  /** Where the platform delivers updates — set on the platform when the bot is saved. */
  webhookUrl: string;
  /** The platform's last refusal of setWebhook, if any — null once it is accepted. */
  webhookError: string | null;
  bindingCount: number;
  identityCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatIntegrationsResponse {
  integrations: ChatIntegrationSummary[];
  /** CHAT_ENABLED. Off means no webhook is accepted, whatever the rows say. */
  enabled: boolean;
}

export interface ChatIntegrationTestResponse {
  ok: boolean;
  botUsername: string | null;
  /** The platform's own words when it refused. */
  error: string | null;
}

/** A group or channel the bot may answer in, and how. DMs need no binding. */
export interface ChatBindingEntry {
  id: string;
  integrationId: string;
  externalChatId: string;
  title: string | null;
  projectId: string | null;
  /** null = the integration's default agent. */
  agentKey: string | null;
  answerMode: ChatAnswerMode;
  /** null = the integration's locale. Replies to a linked person use theirs. */
  locale: Locale | null;
  /** Notification rules on this group (phase 3). */
  subscriptionCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatBindingsResponse {
  bindings: ChatBindingEntry[];
}

/**
 * One notification rule on a bound group. No project and no tags is the whole
 * workspace; tags match with OR, as the search filter does.
 */
export interface ChatSubscriptionEntry {
  id: string;
  bindingId: string;
  projectId: string | null;
  /** Folded the way the graph folds tag keys, so `Billing` and `billing` are one tag. */
  tags: string[];
  eventKinds: ChatSubscriptionEventKind[];
  delivery: ChatSubscriptionDelivery;
  /** Set when `delivery` is `digest`, null otherwise. */
  digestMinutes: ChatDigestMinutes | null;
  /** The last message sent to the group for this rule. */
  lastDeliveredAt: string | null;
  /** The platform's last refusal (the bot was removed from the group, say); null once a message goes through. */
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ChatSubscriptionsResponse {
  subscriptions: ChatSubscriptionEntry[];
}

/** One messenger account linked to one person. */
export interface ChatIdentityEntry {
  id: string;
  integrationId: string;
  integrationName: string;
  kind: ChatPlatformKind;
  workspaceId: string;
  externalUserId: string;
  externalUserName: string | null;
  userId: string;
  /** Resolved for the admin list; null when the account no longer exists. */
  userDisplayName: string | null;
  linkedAt: string;
}

export interface ChatIdentitiesResponse {
  identities: ChatIdentityEntry[];
}

/** What /chat/link shows before a person confirms: who is asking to be linked, and where. */
export interface ChatLinkPreview {
  kind: ChatPlatformKind;
  integrationName: string;
  botUsername: string | null;
  externalUserName: string | null;
  workspaceId: string;
  workspaceName: string;
  expiresAt: string;
}
