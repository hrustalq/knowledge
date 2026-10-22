// Chat bots (issue #71): a workspace answering in a messenger.
//
// Buildless package: no enums, no relative cross-file imports (see
// packages/contracts/src/index.ts).
import type { Locale } from '@knowledge/contracts/core';

/**
 * The messengers a workspace can connect: Telegram, Time (T-Bank's corporate
 * messenger, Mattermost-shaped), Mattermost (#343) — those two sharing one
 * adapter — Slack (#380) and Microsoft Teams (#381). VK Teams joins this list in the release that ships its adapter,
 * never before — a closed vocabulary must not promise a value the code never
 * emits, and the setup form, the DTO guard and the adapter registry all read
 * this one list.
 */
export const CHAT_PLATFORM_KINDS = ['telegram', 'time', 'mattermost', 'slack', 'teams'] as const;
export type ChatPlatformKind = (typeof CHAT_PLATFORM_KINDS)[number];
/** Product names, never translated. */
export const CHAT_PLATFORM_NAMES: Record<ChatPlatformKind, string> = {
  telegram: 'Telegram',
  time: 'Time',
  mattermost: 'Mattermost',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

/**
 * Platforms each customer hosts, so a bot is saved with its server's URL
 * beside the token. The setup form asks for it, the DTO requires it, and the
 * service refuses one for any other kind — one list, read by all three.
 */
export const CHAT_SELF_HOSTED_PLATFORMS: readonly ChatPlatformKind[] = ['time', 'mattermost'];

export function chatPlatformNeedsServer(kind: ChatPlatformKind): boolean {
  return CHAT_SELF_HOSTED_PLATFORMS.includes(kind);
}

/**
 * Platforms that sign every delivery with a secret of their own (Slack's
 * signing secret), so a bot is saved with it beside the token. The form asks
 * for it, the service requires it here and refuses it anywhere else.
 */
export const CHAT_SIGNED_PLATFORMS: readonly ChatPlatformKind[] = ['slack'];

export function chatPlatformNeedsSigningSecret(kind: ChatPlatformKind): boolean {
  return CHAT_SIGNED_PLATFORMS.includes(kind);
}

/**
 * How a bot account is shown: `@name` where the platform has handles, the
 * bare id on Slack (its user id, `U…`) and Teams (its app id).
 */
export function chatBotHandle(kind: ChatPlatformKind, botUsername: string): string {
  return kind === 'slack' || kind === 'teams' ? botUsername : `@${botUsername}`;
}

/**
 * Platforms whose bot is pointed at our webhook by the admin, in the
 * platform's own settings (Slack's Request URL, an Azure Bot's messaging
 * endpoint): the bot card shows the address to paste instead of a delivery
 * status it cannot see.
 */
export const CHAT_PASTED_ENDPOINT_PLATFORMS: readonly ChatPlatformKind[] = ['slack', 'teams'];

export function chatPlatformPastesEndpoint(kind: ChatPlatformKind): boolean {
  return CHAT_PASTED_ENDPOINT_PLATFORMS.includes(kind);
}

/**
 * Platforms whose groups can keep their messages for a harvest (#82, #381):
 * the bot hears a whole group there but has no thread to fetch — Telegram
 * (privacy mode off or an admin bot), Teams (the `ChannelMessage.Read.Group`
 * permission). The switch, its guard and the automatic harvest read this list.
 */
export const CHAT_LISTENING_PLATFORMS: readonly ChatPlatformKind[] = ['telegram', 'teams'];

export function chatPlatformListens(kind: ChatPlatformKind): boolean {
  return CHAT_LISTENING_PLATFORMS.includes(kind);
}

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
 * What Save on a bot answer makes (phase 2; #82 moved both onto agent memory):
 * an `answer` capture citing the answer's pages, or a `glossary` capture the
 * glossarist proposes from the conversation.
 */
export const CHAT_CAPTURE_KINDS = ['page', 'glossary-term'] as const;
export type ChatCaptureKind = (typeof CHAT_CAPTURE_KINDS)[number];

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
  /** The messenger's server, for a self-hosted platform (`chatPlatformNeedsServer`); null otherwise. */
  serverUrl: string | null;
  /** Read from the platform when the integration is saved or tested. */
  botUsername: string | null;
  /** null = the researcher. */
  defaultAgentKey: string | null;
  locale: Locale;
  /**
   * Where the platform delivers updates — set on the platform when the bot is
   * saved. On Time it is where button presses go; messages arrive over the
   * bot's own websocket.
   */
  webhookUrl: string;
  /**
   * Why the bot cannot hear: the platform's last refusal of setWebhook, or on
   * Time the websocket's last failure. null once it is accepted / connected.
   */
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
  /** Messages here are kept, masked, so a thread can be harvested (#82). Telegram only. */
  listening: boolean;
  /**
   * Automatic harvest (#340): the workspace admin who turned it on, whose name
   * its captures carry; null = off. Needs `listening`. Who it runs as is never
   * a request field — enabling makes the caller the owner.
   */
  autoHarvestBy: string | null;
  autoHarvestAt: string | null;
  /**
   * Searchable chat (#339): the workspace admin who turned it on, after the
   * group was told; null = off. Any platform, independent of `listening`.
   */
  searchableBy: string | null;
  searchableAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Searchable chat (#339) for one workspace: the env ceiling, what the
 * workspace asked for, and what applies — the UI shows all three.
 */
export interface ChatSearchSettings {
  /** False while CHAT_SEARCH_ENABLED is off: no binding can be made searchable. */
  available: boolean;
  retentionDays: {
    /** CHAT_SEARCH_RETENTION_DAYS */
    ceiling: number;
    /** null = inherit the ceiling. */
    requested: number | null;
    applied: number;
  };
}

/** The server's side of the automatic harvest (#340): the ceiling and the thresholds every binding gets. */
export interface ChatAutoHarvestLimits {
  /** False while HARVEST_AUTO_ENABLED, HARVEST_ENABLED or CHAT_ENABLED is off: a binding's switch then does nothing. */
  available: boolean;
  /** HARVEST_AUTO_MIN_MESSAGES */
  minMessages: number;
  /** HARVEST_AUTO_QUIET_MINUTES */
  quietMinutes: number;
}

/**
 * One matching window of a searchable group (#339): masked text, authors as
 * `author-n`, never a name. Only from groups the caller may read.
 */
export interface ChatSearchHit {
  chunkId: string;
  bindingId: string;
  chatTitle: string | null;
  platform: ChatPlatformKind;
  /** The binding's project; null = the whole workspace. */
  projectId: string | null;
  firstAt: string;
  lastAt: string;
  messageCount: number;
  snippet: string;
  /** The window's first message, where the platform has links (Telegram supergroups); else null. */
  url: string | null;
  score: number;
}

export interface ChatSearchResponse {
  hits: ChatSearchHit[];
}

/** Whether the caller may read any searchable group (#339): what shows the web's Chat tab. */
export interface ChatSearchAvailability {
  readable: boolean;
}

export interface ChatBindingsResponse {
  bindings: ChatBindingEntry[];
  /** CHAT_LISTEN_TTL_DAYS: how long a listening group's messages are kept. */
  listenTtlDays: number;
  autoHarvest: ChatAutoHarvestLimits;
  search: ChatSearchSettings;
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
