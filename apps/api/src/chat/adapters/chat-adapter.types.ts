import type { ChatPlatformKind } from '@knowledge/contracts';

/**
 * The seam between the chat core and one messenger (issue #71).
 *
 * The core speaks only in the neutral shapes below: it decides *what* to say —
 * an answer with its sources, a one-line notice — and the adapter decides how
 * that looks on its platform (Telegram HTML, Slack mrkdwn, a Teams card) and
 * how it travels. Nothing outside `adapters/` knows a platform's wire format,
 * which is what lets Slack, Teams, Mattermost or VK Teams arrive as one more
 * file plus a line in the registry.
 */

/** A delivery as the webhook received it: headers lowercased, body untouched. */
export interface RawInbound {
  headers: Record<string, string>;
  body: string;
}

/** One message addressed to the bot, normalised. */
export interface ChatInbound {
  externalUserId: string;
  /** `@handle` where the platform has one, else the display name. */
  externalUserName: string | null;
  chatId: string;
  chatTitle: string | null;
  /** A private chat with the bot — no binding needed, and safe for link codes. */
  isDm: boolean;
  messageId: string;
  /** The question with the bot's own @mention removed. */
  text: string;
  /** @mentioned, or a reply to one of the bot's messages. */
  mentioned: boolean;
  /** The message this one replies to, when that message is the bot's. */
  replyToBotMessageId: string | null;
  /** `/name args`, already filtered to commands addressed to this bot. */
  command: { name: string; args: string } | null;
}

/** Where a message goes. */
export interface ChatTarget {
  chatId: string;
  replyToMessageId?: string;
}

/** A message the bot sent, so it can be edited later. */
export interface ChatMessageRef {
  chatId: string;
  messageId: string;
}

/** A link button under a message. */
export interface ChatButton {
  label: string;
  url: string;
}

/** The platform's own rendering of a view. */
export interface ChatOutMessage {
  text: string;
  /** Plain text is the fallback when the formatted text is refused. */
  plain: string;
  buttons: ChatButton[];
}

/** An answer: markdown with `[S#]` markers, and the sources those labels name. */
export interface ChatAnswerView {
  kind: 'answer';
  answer: string;
  sources: Array<{ cite?: string; title: string; url: string }>;
  sourcesHeading: string;
  /** Where the whole answer is — offered by the adapter only when it had to cut. */
  full: ChatButton | null;
  /** Relative page links (`/documents/:id`) are resolved against this. */
  webBaseUrl: string;
}

/** Everything else the bot says: a placeholder, a refusal, a link instruction. */
export interface ChatNoticeView {
  kind: 'notice';
  text: string;
  button?: ChatButton;
}

export type ChatView = ChatAnswerView | ChatNoticeView;

/** What a call to the platform needs; built per call from the integration row. */
export interface ChatAdapterContext {
  token: string;
  botUsername: string | null;
}

/** The platform refused or could not be reached. The message never contains the token. */
export class ChatPlatformError extends Error {
  constructor(
    message: string,
    /** The platform's refusal was about the formatting, so plain text may still go through. */
    readonly formatting = false,
  ) {
    super(message);
    this.name = 'ChatPlatformError';
  }
}

export interface ChatAdapter {
  readonly kind: ChatPlatformKind;
  readonly limits: { maxChars: number };

  /** Constant-time check of the delivery's shared secret against the stored hash. */
  verifyInbound(raw: RawInbound, secretHash: string | null): boolean;
  /** Messages addressed to the bot; anything else (edits, joins, other bots' commands) is dropped. */
  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[];

  render(view: ChatView): ChatOutMessage;
  postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef>;
  editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void>;

  /** Who the token belongs to — the health check, and how `botUsername` is learned. */
  identify(ctx: ChatAdapterContext): Promise<{ username: string }>;
  /** Point the platform at our webhook, handing it the shared secret. */
  registerWebhook(ctx: ChatAdapterContext, url: string, secret: string): Promise<void>;
  /** A link that opens a private chat with the bot, or null if the platform has none. */
  directLink(botUsername: string | null, payload?: string): string | null;
}
