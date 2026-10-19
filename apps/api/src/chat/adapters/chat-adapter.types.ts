import type { ChatPlatformKind } from '@knowledge/contracts';

/**
 * The seam between the chat core and one messenger (issue #71).
 *
 * The core speaks only in the neutral shapes below: it decides *what* to say —
 * an answer with its sources, a one-line notice — and the adapter decides how
 * that looks on its platform (Telegram HTML, Time markdown with attachment
 * buttons) and how it travels. Nothing outside `adapters/` knows a platform's
 * wire format, which is what lets Mattermost or VK Teams arrive as one more
 * file plus a line in the registry.
 *
 * Two inbound paths feed the same {@link ChatAdapter.parseInbound}: a webhook
 * the platform POSTs to (Telegram's updates, Time's button presses), checked
 * by {@link ChatAdapter.verifyInbound}, and the bot's own websocket (Time's
 * messages), which `ChatSocketSupervisor` holds and nothing outside can write to.
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
  /**
   * The message this one replies to, when that message may be the bot's. On
   * Telegram the adapter knows it is; on Time it is the thread's root, and the
   * core checks it against the answers it posted.
   */
  replyToBotMessageId: string | null;
  /**
   * The thread the message belongs to, on a platform with real threads (Time:
   * the root post, or the message itself when it starts one in a channel).
   * Later messages in a thread the bot answered in are follow-ups. Always null
   * on Telegram, which has reply chains instead.
   */
  threadId: string | null;
  /** `/name args`, already filtered to commands addressed to this bot. */
  command: { name: string; args: string } | null;
  /**
   * A press of one of the bot's own buttons. `messageId` is then the bot's
   * message the button sits on, `text` is empty, and `data` is exactly what
   * the core put in the {@link ChatActionButton} — the platform hands it back
   * untouched, and only for buttons this bot sent.
   */
  action: { id: string; data: string } | null;
  /** When the message was sent; absent where the platform did not say. */
  at?: Date;
  /**
   * The message this one replies to, whoever wrote it, as the platform
   * delivered it — where a Telegram `/capture` starts reading (#82). The text
   * is raw: never stored, only handed to a harvest, which masks it.
   */
  replyTo?: ChatQuotedMessage | null;
  /** Forwarded into the chat: the original's author and time (#82). */
  forwardedFrom?: { authorId: string; at: Date } | null;
  /** A Telegram forum topic the message is in; null outside one. */
  topicId?: string | null;
}

/** A message another one quotes by replying to it. */
export interface ChatQuotedMessage {
  messageId: string;
  authorId: string;
  /** Empty for a message with no text (a topic's opening, a photo with no caption). */
  text: string;
  at: Date;
  fromBot: boolean;
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

/** A button that opens a link. */
export interface ChatLinkButton {
  label: string;
  url: string;
}

/**
 * A button that comes back as an inbound `action` carrying `action` as its
 * data. The core owns the encoding (`chat-actions.ts`); the adapter only
 * carries it, within `limits.maxActionBytes`.
 */
export interface ChatActionButton {
  label: string;
  action: string;
}

export type ChatButton = ChatLinkButton | ChatActionButton;

/** The platform's own rendering of a view. */
export interface ChatOutMessage {
  text: string;
  /** Plain text is the fallback when the formatted text is refused. */
  plain: string;
  /** Rows of buttons, top to bottom. */
  buttons: ChatButton[][];
}

/** An answer: markdown with `[S#]` markers, and the sources those labels name. */
export interface ChatAnswerView {
  kind: 'answer';
  answer: string;
  sources: Array<{ cite?: string; title: string; url: string }>;
  sourcesHeading: string;
  /** Where the whole answer is — offered by the adapter only when it had to cut. */
  full: ChatLinkButton | null;
  /** Rows of action buttons under the answer — the vote row, or the reasons for a 👎. */
  actions: ChatActionButton[][];
  /** Relative page links (`/documents/:id`) are resolved against this. */
  webBaseUrl: string;
}

/** Everything else the bot says: a placeholder, a refusal, a link instruction. */
export interface ChatNoticeView {
  kind: 'notice';
  text: string;
  button?: ChatLinkButton;
}

/**
 * What changed, for a subscribed group (phase 3): one line per page or merge
 * request — a label, a title and a link, never content. One event or a digest
 * of many; `more` is the line for what did not fit.
 */
export interface ChatUpdatesView {
  kind: 'updates';
  heading: string | null;
  items: Array<{ label: string; title: string; url: string }>;
  more: string | null;
  button?: ChatLinkButton;
}

export type ChatView = ChatAnswerView | ChatNoticeView | ChatUpdatesView;

/** One message of a thread read for a harvest (#82): who wrote it, as the platform's opaque id. */
export interface ChatThreadMessage {
  authorId: string;
  text: string;
  at: Date;
}

/** A thread as a harvest reads it: people's messages only, oldest first. */
export interface ChatThread {
  messages: ChatThreadMessage[];
  /** A link to the thread, where the platform has one. */
  url: string | null;
  /** Messages left out to stay within the cap. */
  truncated: boolean;
}

/** What a call to the platform needs; built per call from the integration row. */
export interface ChatAdapterContext {
  token: string;
  botUsername: string | null;
  /** The messenger's own server, for a self-hosted platform (Time); null where the API is fixed. */
  serverUrl: string | null;
  /** Our webhook: where a platform that is told per button (Time) sends a press. */
  actionUrl: string;
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
  /** `maxActionBytes`: the most a {@link ChatActionButton}'s data may carry. */
  readonly limits: { maxChars: number; maxActionBytes: number };
  /**
   * How messages reach us: the platform POSTs them to our webhook, or we read
   * them off the bot's websocket (`ChatSocketSupervisor`), in which case the
   * socket's state is what says whether the bot can hear.
   */
  readonly inbound: 'webhook' | 'socket';

  /**
   * Is this webhook delivery the platform's? Telegram echoes a shared secret,
   * compared against the stored hash; Time sends nothing to check, so its
   * buttons carry a signature over their data, keyed by the bot's token
   * (`ctx`). Constant-time either way. Websocket messages never come here.
   */
  verifyInbound(raw: RawInbound, secretHash: string | null, ctx: ChatAdapterContext | null): boolean;
  /** Messages addressed to the bot; anything else (edits, joins, other bots' commands) is dropped. */
  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[];

  render(view: ChatView): ChatOutMessage;
  postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef>;
  editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void>;
  /**
   * Close out a button press — the platform shows a spinner until this is
   * called — with an optional short note shown only to the person who pressed.
   */
  acknowledge(ctx: ChatAdapterContext, actionId: string, note?: string): Promise<void>;
  /**
   * For a platform that takes the press's reply in the HTTP response rather
   * than as a later call (Time): what the webhook answers for this press,
   * once {@link acknowledge} has been called for it or `handled` settles,
   * whichever is first. Absent where acknowledging is a call of its own.
   */
  respondToAction?(inbound: ChatInbound, handled: Promise<void>): Promise<unknown>;

  /** Who the token belongs to — the health check, and how `botUsername` is learned. */
  identify(ctx: ChatAdapterContext): Promise<{ username: string }>;
  /**
   * Point the platform at our webhook, handing it the shared secret. A no-op
   * where messages arrive over the bot's websocket instead (Time).
   */
  registerWebhook(ctx: ChatAdapterContext, url: string, secret: string): Promise<void>;
  /**
   * The thread rooted at `rootId`, up to (not including) `beforeMessageId` —
   * the command that asked for it — and at most `max` messages: the root and
   * the newest replies. Bots' and system messages are left out. Absent on a
   * platform with no thread to fetch (Telegram, whose threads are read from
   * the listening buffer or a DM's forwards instead — `ChatBufferService`).
   */
  fetchThread?(ctx: ChatAdapterContext, chatId: string, rootId: string, beforeMessageId: string, max: number): Promise<ChatThread>;
  /** A link to one message, where the platform has one for this chat; the origin of a harvest from the buffer. */
  messageUrl?(chatId: string, messageId: string): string | null;
  /** A link that opens a private chat with the bot, or null if the platform has none. */
  directLink(botUsername: string | null, payload?: string): string | null;
}
