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
  createdAt: string;
  updatedAt: string;
}

export interface ChatBindingsResponse {
  bindings: ChatBindingEntry[];
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
