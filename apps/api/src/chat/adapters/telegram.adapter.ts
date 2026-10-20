import { createHash, timingSafeEqual } from 'node:crypto';
import { CITE_MARKER_RE } from '../../assistant/citations.js';
import {
  ChatPlatformError,
  type ChatAdapter,
  type ChatAdapterContext,
  type ChatAnswerView,
  type ChatButton,
  type ChatLinkButton,
  type ChatInbound,
  type ChatMessageRef,
  type ChatOutMessage,
  type ChatTarget,
  type ChatUpdatesView,
  type ChatView,
  type RawInbound,
} from './chat-adapter.types.js';

/** Telegram counts this many characters of message text, after entity parsing. */
const MAX_CHARS = 4096;
/** `callback_data` is 1–64 bytes. */
const MAX_ACTION_BYTES = 64;
/** An `answerCallbackQuery` note longer than this is refused. */
const MAX_NOTE_CHARS = 200;
/** Below the limit, for the "…" and whatever the sources block adds. */
const ANSWER_HEADROOM = 200;
const CALL_TIMEOUT_MS = 15_000;
/** The header Telegram echoes `secret_token` in on every delivery. */
const SECRET_HEADER = 'x-telegram-bot-api-secret-token';

/** The SHA-256 a stored inbound secret is compared through. */
export function hashInboundSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string): string => escapeHtml(s).replace(/"/g, '&quot;');

/** `[text](url)`, the URL allowed one level of parentheses (Wikipedia's are common). */
const MD_LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

/** `S3` → `3`: the reader sees a footnote number, not the model's label. */
const citeNumber = (label: string): string => label.replace(/^S/i, '');

/**
 * Where a link in an answer may point. Page links arrive relative
 * (`/documents/:id`, the PAGE_LINK_RULE shape), which mean nothing in a chat
 * client; anything that is not http(s) after resolving is dropped to its text.
 */
function resolveUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base.endsWith('/') ? base : `${base}/`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** One line of prose: inline code, links, citation markers, emphasis. */
function inlineHtml(line: string, cite: (label: string) => string | null, base: string): string {
  const held: string[] = [];
  const hold = (html: string) => `\uE000${held.push(html) - 1}\uE000`;
  let s = line.replace(/`([^`\n]+)`/g, (_, code: string) => hold(`<code>${escapeHtml(code)}</code>`));
  s = escapeHtml(s);
  s = s.replace(MD_LINK_RE, (_, text: string, href: string) => {
    // Already escaped once with the rest of the line; undo it for URL parsing.
    const url = resolveUrl(href.replace(/&amp;/g, '&'), base);
    return url ? hold(`<a href="${escapeAttr(url)}">${text}</a>`) : text;
  });
  s = s.replace(new RegExp(CITE_MARKER_RE.source, 'gi'), (_, labels: string) =>
    labels
      .split(/\s*[,;]\s*/)
      .map((label) => {
        const url = cite(label.toUpperCase());
        const n = `[${citeNumber(label)}]`;
        return url ? hold(`<a href="${escapeAttr(url)}">${n}</a>`) : n;
      })
      .join(''),
  );
  s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+?)__/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  return s.replace(/\uE000(\d+)\uE000/g, (_, i: string) => held[Number(i)]);
}

/**
 * Markdown, as an answer writes it, to the HTML subset Telegram's
 * `parse_mode=HTML` accepts (b, i, code, pre, a). Headings become bold lines,
 * bullets become `•`, tables stay as text — a chat client has no layout to give
 * them. Everything is escaped before any tag is added, so text from a page can
 * never inject markup; a malformed result is caught by Telegram and the plain
 * fallback is sent instead.
 */
export function markdownToTelegramHtml(md: string, cite: (label: string) => string | null, base: string): string {
  const out: string[] = [];
  const fence = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  const prose = (chunk: string) => {
    for (const line of chunk.split('\n')) {
      const heading = /^#{1,6}\s+(.*)$/.exec(line);
      const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
      const quote = /^>\s?(.*)$/.exec(line);
      if (heading) out.push(`<b>${inlineHtml(heading[1], cite, base)}</b>`);
      else if (bullet) out.push(`• ${inlineHtml(bullet[1], cite, base)}`);
      else if (quote) out.push(inlineHtml(quote[1], cite, base));
      else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) out.push('');
      else out.push(inlineHtml(line, cite, base));
    }
  };
  while ((m = fence.exec(md))) {
    // The newlines around a fence belong to the fence, not to an empty line of prose.
    prose(md.slice(last, m.index).replace(/\n$/, ''));
    out.push(`<pre>${escapeHtml(m[1].replace(/\n$/, ''))}</pre>`);
    last = m.index + m[0].length;
    if (md[last] === '\n') last++;
  }
  prose(md.slice(last));
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** The same answer with the markup taken out — what is sent when the HTML is refused. */
export function markdownToPlain(md: string): string {
  return md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, '$1')
    .replace(new RegExp(CITE_MARKER_RE.source, 'gi'), (_, labels: string) =>
      labels
        .split(/\s*[,;]\s*/)
        .map((l) => `[${citeNumber(l)}]`)
        .join(''),
    )
    .replace(MD_LINK_RE, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .trim();
}

/**
 * Cut an answer to `budget` characters at the last paragraph or sentence that
 * fits. Markdown is never shorter than the text Telegram counts after parsing
 * (link targets and `S` prefixes vanish), so a cut that fits here fits there.
 */
export function cutAnswer(md: string, budget: number): { text: string; cut: boolean } {
  if (md.length <= budget) return { text: md, cut: false };
  const window = md.slice(0, budget);
  const at = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '), window.lastIndexOf('\n'));
  // An open code fence would swallow the rest of the message — close it.
  let text = (at > budget / 2 ? window.slice(0, at + 1) : window).trimEnd();
  if ((text.match(/```/g)?.length ?? 0) % 2 === 1) text += '\n```';
  return { text: `${text}\n…`, cut: true };
}

/**
 * A subscription's message: a bold heading, then `label: title` lines with the
 * title as the link. Titles are escaped like everything else — a page title is
 * text somebody typed.
 */
function renderUpdates(view: ChatUpdatesView): ChatOutMessage {
  const html = view.items.map((i) => `${escapeHtml(i.label)}: <a href="${escapeAttr(i.url)}">${escapeHtml(i.title)}</a>`);
  const plain = view.items.map((i) => `${i.label}: ${i.title} — ${i.url}`);
  if (view.more) {
    html.push(escapeHtml(view.more));
    plain.push(view.more);
  }
  const head = (h: string) => (view.heading ? [h] : []);
  return {
    text: [...head(`<b>${escapeHtml(view.heading ?? '')}</b>`), ...html].join('\n').slice(0, MAX_CHARS),
    plain: [...head(view.heading ?? ''), ...plain].join('\n').slice(0, MAX_CHARS),
    buttons: view.button ? [[view.button]] : [],
  };
}

/**
 * Telegram (issue #71, phase 1). Bot API over plain `fetch` — there is no SDK
 * here, for the reason ArcadeDB has none: the surface is five methods.
 *
 * Groups have no threads, only reply chains, so the core keys a follow-up on
 * "this is a reply to the bot's answer" (`replyToBotMessageId`). A bot in
 * privacy mode (the default) is only shown messages that mention it, reply to
 * it or are commands — exactly what it answers, and nothing it would read.
 */
export class TelegramAdapter implements ChatAdapter {
  readonly kind = 'telegram' as const;
  readonly limits = { maxChars: MAX_CHARS, maxActionBytes: MAX_ACTION_BYTES };
  readonly inbound = 'webhook' as const;

  constructor(private readonly apiBase: string) {}

  verifyInbound(raw: RawInbound, secretHash: string | null): boolean {
    const presented = raw.headers[SECRET_HEADER];
    if (!secretHash || !presented) return false;
    const a = Buffer.from(hashInboundSecret(presented), 'hex');
    const b = Buffer.from(secretHash, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }

  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[] {
    let update: TelegramUpdate;
    try {
      update = JSON.parse(raw.body) as TelegramUpdate;
    } catch {
      return [];
    }
    if (update.callback_query) return this.parseCallback(update.callback_query);
    if (update.message_reaction) return parseReaction(update.message_reaction);
    // An edit arrives as the whole message again (#339); the Bot API never reports a deletion.
    const msg = update.message ?? update.edited_message;
    if (!msg?.from || msg.from.is_bot || !msg.chat) return [];
    const original = (msg.text ?? msg.caption ?? '').trim();
    if (!original) return [];
    const bot = botUsername?.toLowerCase() ?? null;
    const isDm = msg.chat.type === 'private';

    let command: ChatInbound['command'] = null;
    const cmd = /^\/([A-Za-z0-9_]+)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(original);
    if (cmd) {
      // `/help@OtherBot` in a group is somebody else's command.
      if (cmd[2] && cmd[2].toLowerCase() !== bot) return [];
      command = { name: cmd[1].toLowerCase(), args: (cmd[3] ?? '').trim() };
    }

    const replyTo = msg.reply_to_message;
    const replyToBotMessageId =
      replyTo?.from?.is_bot && bot && replyTo.from.username?.toLowerCase() === bot ? String(replyTo.message_id) : null;
    const mentionRe = bot ? new RegExp(`@${bot}\\b`, 'gi') : null;
    const mentioned = !!replyToBotMessageId || (!!mentionRe && mentionRe.test(original));
    const text = (mentionRe ? original.replace(mentionRe, ' ') : original).replace(/\s+/g, ' ').trim();

    return [
      {
        externalUserId: String(msg.from.id),
        externalUserName: displayName(msg.from),
        chatId: String(msg.chat.id),
        chatTitle: msg.chat.title ?? null,
        isDm,
        messageId: String(msg.message_id),
        text,
        mentioned,
        replyToBotMessageId,
        threadId: null,
        command,
        action: null,
        ...(msg.date ? { at: new Date((update.edited_message ? (msg.edit_date ?? msg.date) : msg.date) * 1000) } : {}),
        ...(update.edited_message ? { change: 'edited' as const } : {}),
        replyTo: replyTo
          ? {
              messageId: String(replyTo.message_id),
              authorId: replyTo.from ? String(replyTo.from.id) : '',
              text: (replyTo.text ?? replyTo.caption ?? '').trim(),
              at: new Date(replyTo.date * 1000),
              fromBot: !!replyTo.from?.is_bot,
            }
          : null,
        forwardedFrom: msg.forward_origin ? { authorId: forwardAuthor(msg.forward_origin), at: new Date(msg.forward_origin.date * 1000) } : null,
        topicId: msg.is_topic_message && msg.message_thread_id ? String(msg.message_thread_id) : null,
      },
    ];
  }

  /** A press of an inline button. Telegram sends one only for a button this bot put on its own message. */
  private parseCallback(cb: TelegramCallbackQuery): ChatInbound[] {
    const msg = cb.message;
    if (!cb.from || cb.from.is_bot || !msg?.chat || !cb.data) return [];
    return [
      {
        externalUserId: String(cb.from.id),
        externalUserName: displayName(cb.from),
        chatId: String(msg.chat.id),
        chatTitle: msg.chat.title ?? null,
        isDm: msg.chat.type === 'private',
        messageId: String(msg.message_id),
        text: '',
        mentioned: false,
        replyToBotMessageId: null,
        threadId: null,
        command: null,
        action: { id: cb.id, data: cb.data },
      },
    ];
  }

  render(view: ChatView): ChatOutMessage {
    if (view.kind === 'notice') {
      return { text: escapeHtml(view.text), plain: view.text, buttons: view.button ? [[view.button]] : [] };
    }
    if (view.kind === 'updates') return renderUpdates(view);
    return this.renderAnswer(view);
  }

  private renderAnswer(view: ChatAnswerView): ChatOutMessage {
    const urls = new Map(view.sources.filter((s) => s.cite).map((s) => [s.cite!.toUpperCase(), s.url]));
    const numbered = view.sources.map((s, i) => ({ ...s, n: s.cite ? citeNumber(s.cite) : String(i + 1) }));
    const sourcesHtml = numbered.length
      ? `\n\n<b>${escapeHtml(view.sourcesHeading)}</b>\n` +
        numbered.map((s) => `[${s.n}] <a href="${escapeAttr(s.url)}">${escapeHtml(s.title)}</a>`).join('\n')
      : '';
    const sourcesPlain = numbered.length
      ? `\n\n${view.sourcesHeading}\n` + numbered.map((s) => `[${s.n}] ${s.title} — ${s.url}`).join('\n')
      : '';
    const { text, cut } = cutAnswer(view.answer, MAX_CHARS - ANSWER_HEADROOM - sourcesPlain.length);
    return {
      text: markdownToTelegramHtml(text, (label) => urls.get(label) ?? null, view.webBaseUrl) + sourcesHtml,
      plain: (markdownToPlain(text) + sourcesPlain).slice(0, MAX_CHARS),
      buttons: [...(cut && view.full ? [[view.full]] : []), ...view.actions],
    };
  }

  async postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef> {
    const base = {
      chat_id: target.chatId,
      ...(target.replyToMessageId
        ? { reply_parameters: { message_id: Number(target.replyToMessageId), allow_sending_without_reply: true } }
        : {}),
    };
    const sent = await this.withPlainFallback(msg, (body) =>
      this.call<{ message_id: number }>(ctx, 'sendMessage', { ...base, ...body }),
    );
    return { chatId: target.chatId, messageId: String(sent.message_id) };
  }

  async editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void> {
    try {
      await this.withPlainFallback(msg, (body) =>
        this.call(ctx, 'editMessageText', { chat_id: ref.chatId, message_id: Number(ref.messageId), ...body }),
      );
    } catch (err) {
      // Editing to the text it already has is a refusal on Telegram's side and
      // a success on ours: a redelivered reaper edit lands here.
      if (err instanceof ChatPlatformError && /not modified/i.test(err.message)) return;
      throw err;
    }
  }

  async acknowledge(ctx: ChatAdapterContext, actionId: string, note?: string): Promise<void> {
    await this.call(ctx, 'answerCallbackQuery', {
      callback_query_id: actionId,
      ...(note ? { text: note.slice(0, MAX_NOTE_CHARS) } : {}),
    });
  }

  async identify(ctx: ChatAdapterContext): Promise<{ username: string }> {
    const me = await this.call<{ username?: string }>(ctx, 'getMe', {});
    if (!me.username) throw new ChatPlatformError('getMe returned no username');
    return { username: me.username };
  }

  async registerWebhook(ctx: ChatAdapterContext, url: string, secret: string): Promise<void> {
    await this.call(ctx, 'setWebhook', {
      url,
      secret_token: secret,
      // Only what the bot acts on: a question, a press of its own buttons, a
      // reaction — which Telegram sends only where the bot is a group admin —
      // and an edit, which a searchable group's kept copy follows (#339).
      // Joins would be deliveries to verify and drop.
      allowed_updates: ['message', 'edited_message', 'callback_query', 'message_reaction'],
      drop_pending_updates: true,
    });
  }

  /**
   * A supergroup's message as `t.me/c/…`, which opens for its members. A basic
   * group or a private chat has no message links.
   */
  messageUrl(chatId: string, messageId: string): string | null {
    return chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null;
  }

  directLink(botUsername: string | null, payload?: string): string | null {
    if (!botUsername) return null;
    return `https://t.me/${botUsername}${payload ? `?start=${encodeURIComponent(payload)}` : ''}`;
  }

  /**
   * HTML first, then — only when Telegram says the formatting or a button was
   * the problem — the plain text with link targets written out. A localhost
   * button URL in development is refused the same way a broken tag is. Action
   * buttons carry no URL to refuse, so they stay on the fallback as buttons.
   */
  private async withPlainFallback<T>(msg: ChatOutMessage, send: (body: Record<string, unknown>) => Promise<T>): Promise<T> {
    try {
      return await send({ text: msg.text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...keyboard(msg.buttons) });
    } catch (err) {
      if (!(err instanceof ChatPlatformError) || !err.formatting) throw err;
      const links = msg.buttons
        .flat()
        .filter((b): b is ChatLinkButton => 'url' in b)
        .map((b) => `${b.label}: ${b.url}`)
        .join('\n');
      const actions = msg.buttons.map((row) => row.filter((b) => !('url' in b))).filter((row) => row.length);
      return send({
        text: [msg.plain, links].filter(Boolean).join('\n\n').slice(0, MAX_CHARS),
        link_preview_options: { is_disabled: true },
        ...keyboard(actions),
      });
    }
  }

  /** One Bot API call. Errors carry the method and Telegram's description — never the URL, which holds the token. */
  private async call<T = unknown>(ctx: ChatAdapterContext, method: string, body: Record<string, unknown>): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.apiBase.replace(/\/$/, '')}/bot${ctx.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new ChatPlatformError(`telegram ${method}: ${reason}`);
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
    if (!json?.ok) {
      const description = json?.description ?? `HTTP ${res.status}`;
      const formatting = res.status === 400 && /parse entities|button|url|entity/i.test(description);
      throw new ChatPlatformError(`telegram ${method}: ${description}`, formatting);
    }
    return json.result as T;
  }
}

/** `@handle` where there is one, else the display name. */
function displayName(user: TelegramUser): string | null {
  return user.username ? `@${user.username}` : [user.first_name, user.last_name].filter(Boolean).join(' ') || null;
}

/**
 * ✍ just added to a group's message by a person (#82). Telegram's reactions
 * have no 📌, and ✍ reads as "write this down". The reaction carries no text,
 * so the message is read from the listening buffer. Anonymous admins have no
 * one to link; a private chat has nothing kept to read.
 */
const HARVEST_REACTION = '✍';

function parseReaction(r: TelegramMessageReaction): ChatInbound[] {
  if (!r.user || r.user.is_bot || !r.chat || r.chat.type === 'private') return [];
  const writes = (list: TelegramReactionType[] | undefined) =>
    !!list?.some((x) => x.type === 'emoji' && x.emoji?.replace(/️/g, '') === HARVEST_REACTION);
  // Added now, not merely still there while another reaction changes.
  if (!writes(r.new_reaction) || writes(r.old_reaction)) return [];
  return [
    {
      externalUserId: String(r.user.id),
      externalUserName: displayName(r.user),
      chatId: String(r.chat.id),
      chatTitle: r.chat.title ?? null,
      isDm: false,
      messageId: String(r.message_id),
      text: '',
      mentioned: false,
      replyToBotMessageId: null,
      threadId: null,
      command: null,
      action: null,
      at: new Date(r.date * 1000),
      harvestReaction: true,
    },
  ];
}

/** Who a forward came from, as an opaque id: the user, the chat, or the name a hidden user goes by. */
function forwardAuthor(origin: TelegramForwardOrigin): string {
  if (origin.sender_user) return String(origin.sender_user.id);
  if (origin.sender_chat ?? origin.chat) return String((origin.sender_chat ?? origin.chat)!.id);
  return `name:${origin.sender_user_name ?? ''}`;
}

/** Rows of buttons as Telegram's inline keyboard; nothing at all when there are none. */
function keyboard(rows: ChatButton[][]): Record<string, unknown> {
  if (!rows.length) return {};
  return {
    reply_markup: {
      inline_keyboard: rows.map((row) =>
        row.map((b) => ('url' in b ? { text: b.label, url: b.url } : { text: b.label, callback_data: b.action })),
      ),
    },
  };
}

interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

interface TelegramMessage {
  message_id: number;
  /** Unix seconds. */
  date: number;
  from?: TelegramUser;
  chat?: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string };
  text?: string;
  caption?: string;
  /** In a forum, a topic's message replies to the topic's opening unless it replies to something else. */
  reply_to_message?: { message_id: number; date: number; from?: TelegramUser; text?: string; caption?: string };
  forward_origin?: TelegramForwardOrigin;
  is_topic_message?: boolean;
  message_thread_id?: number;
  /** Unix seconds; on an `edited_message` only. */
  edit_date?: number;
}

/** MessageOrigin: `user`, `hidden_user`, `chat` or `channel`. */
interface TelegramForwardOrigin {
  type: string;
  date: number;
  sender_user?: TelegramUser;
  sender_user_name?: string;
  sender_chat?: { id: number };
  chat?: { id: number };
}

interface TelegramCallbackQuery {
  id: string;
  from?: TelegramUser;
  /** Absent when the message is too old for Telegram to send. */
  message?: { message_id: number; chat?: TelegramMessage['chat'] };
  data?: string;
}

/** ReactionType: `emoji`, `custom_emoji` or `paid`. */
interface TelegramReactionType {
  type: string;
  emoji?: string;
}

/** MessageReactionUpdated. `user` is absent for an anonymous admin, who acts as `actor_chat`. */
interface TelegramMessageReaction {
  chat?: TelegramMessage['chat'];
  message_id: number;
  user?: TelegramUser;
  /** Unix seconds. */
  date: number;
  old_reaction?: TelegramReactionType[];
  new_reaction?: TelegramReactionType[];
}

interface TelegramUpdate {
  update_id?: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
  message_reaction?: TelegramMessageReaction;
}
