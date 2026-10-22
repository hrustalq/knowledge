import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { CITE_MARKER_RE } from '../../assistant/citations.js';
import {
  ChatPlatformError,
  type ChatActionButton,
  type ChatAdapter,
  type ChatAdapterContext,
  type ChatAnswerView,
  type ChatButton,
  type ChatInbound,
  type ChatMessageRef,
  type ChatOutMessage,
  type ChatTarget,
  type ChatThread,
  type ChatUpdatesView,
  type ChatView,
  type RawInbound,
} from './chat-adapter.types.js';
import { MD_LINK_RE, citeNumber, parseJson, plainCommand, resolveUrl } from './mattermost.adapter.js';
import { cutAnswer } from './telegram.adapter.js';

const SLACK_API = 'https://slack.com/api';
/** What one message holds: four 3000-character sections, with room for the sources. */
const MAX_CHARS = 12_000;
const SECTION_CHARS = 3000;
/** A button's `value`. */
const MAX_ACTION_BYTES = 2000;
const ANSWER_HEADROOM = 400;
const CALL_TIMEOUT_MS = 15_000;
/** Slack's own replay window for a signed request. */
const SIGNATURE_MAX_AGE_SEC = 300;
/** The harvest reaction (#82): `:pushpin:`, as on Time and Mattermost. */
const HARVEST_EMOJI = 'pushpin';
/** Messages whose thread this process has seen, so a reply finds its root without a call. */
const THREAD_MEMORY = 5_000;
/** One page of `conversations.replies`, Slack's maximum. */
const THREAD_PAGE = 1000;
/** Message subtypes that are still a person writing; every other subtype is a join, a topic change, a bot… */
const PERSON_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share']);

/**
 * Slack's request signature (v0): HMAC-SHA256 over `v0:<timestamp>:<body>`,
 * keyed by the app's signing secret. Exported for the spec, which signs its
 * fixtures the way Slack does.
 */
export function slackSignature(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex')}`;
}

/** Slack's three control characters, escaped wherever text is not a link we built. */
const escapeText = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A link's label may not hold `|` or `>`, which would end it early. */
const escapeLabel = (s: string): string => escapeText(s).replace(/\|/g, '¦');
const link = (url: string, label: string): string => `<${url}|${escapeLabel(label)}>`;
/**
 * An answer's markdown as Slack's `mrkdwn`. Links and citations become
 * `<url|label>` (relative page links resolved, non-http dropped); everything
 * else is escaped, which is also what keeps `<!channel>` or `<@U…>` quoted
 * from a page from pinging anyone — a message posted through the API pings
 * only through that syntax. Bold, strike and headings are rewritten to
 * Slack's single-character forms; code fences keep their content and lose
 * their language, which Slack would print.
 */
export function markdownForSlack(md: string, cite: (label: string) => string | null, base: string): string {
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part.replace(/^```[^\n]*\n([\s\S]*?)```$/, (_, code: string) => `\`\`\`\n${escapeText(code)}\`\`\``);
      const links: string[] = [];
      const hold = (s: string): string => `\u0000${links.push(s) - 1}\u0000`;
      let s = part.replace(MD_LINK_RE, (_, text: string, href: string) => {
        const url = resolveUrl(href, base);
        return url ? hold(link(url, text)) : text;
      });
      s = s.replace(new RegExp(CITE_MARKER_RE.source, 'gi'), (_, labels: string) =>
        labels
          .split(/\s*[,;]\s*/)
          .map((label) => {
            const url = cite(label.toUpperCase());
            const n = citeNumber(label);
            return url ? hold(link(url, `[${n}]`)) : `[${n}]`;
          })
          .join(''),
      );
      s = escapeText(s)
        // Markdown's *italic* first: on Slack a single star is bold.
        .replace(/(^|[^*\w])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?!\*)/g, '$1_$2_')
        .replace(/\*\*(.+?)\*\*/g, '*$1*')
        .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
        .replace(/__(.+?)__/g, '_$1_')
        .replace(/~~(.+?)~~/g, '~$1~');
      return s.replace(/\u0000(\d+)\u0000/g, (_, n: string) => links[Number(n)]);
    })
    .join('')
    .trim();
}

/**
 * What a person typed, as plain text for a question or a harvest: Slack's
 * `<url|label>`, `<url>` and `<#C…|name>` markup read back, entities decoded.
 * A colleague's `<@U…>` is left as it is — an opaque id, like an author's.
 */
export function slackPlainText(text: string): string {
  return text
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<(https?:[^>|]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:[^>|]+)>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

const tsDate = (ts: string | undefined): Date | undefined => (ts && Number.isFinite(Number(ts)) ? new Date(Number(ts) * 1000) : undefined);
/** A direct chat's channel id starts with `D`; the events say `channel_type: 'im'` too, a press does not. */
const isDmChannel = (channel: string): boolean => channel.startsWith('D');

function renderUpdates(view: ChatUpdatesView): string {
  const lines = view.items.map((i) => `• ${escapeText(i.label)}: ${link(i.url, i.title)}`);
  if (view.more) lines.push(escapeText(view.more));
  return [...(view.heading ? [`*${escapeText(view.heading)}*`] : []), ...lines].join('\n').slice(0, MAX_CHARS);
}

/** Text cut into section-sized pieces, at a line break where there is one. */
function sections(text: string): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > SECTION_CHARS) {
    const at = rest.lastIndexOf('\n', SECTION_CHARS);
    const cut = at > SECTION_CHARS / 2 ? at : SECTION_CHARS;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) out.push(rest);
  return out;
}

/**
 * Slack (#380), through the Events API and an **internal** app each workspace
 * admin creates — a Marketplace app would be throttled to one history call a
 * minute, which no harvest survives. Plain `fetch` to the fixed `slack.com`
 * API: there is no SDK here, for the reason there is none for Telegram.
 *
 * What differs from the others, and where it went:
 *
 * - **Every request is signed** with the app's signing secret
 *   (`X-Slack-Signature`, v0 HMAC-SHA256 over timestamp and body), and one older
 *   than five minutes is refused as a replay ({@link verifyInbound}). The
 *   secret is kept in the secret box beside the token.
 * - **Messages and presses share our webhook.** Events arrive as JSON;
 *   interactivity as a form with a `payload`. Setting the Request URL makes
 *   Slack send a signed `url_verification` first, answered by {@link handshake}.
 * - **Real threads** (`thread_ts`), Time's rules: in a channel the bot answers
 *   in the question's thread, in a direct chat at the top unless asked inside
 *   a thread. Slack wants the root as `thread_ts`, never a reply, so the
 *   adapter remembers each message's root as it parses it.
 * - **The bot is its user id** (`auth.test`'s `user_id`): a mention is
 *   `<@U…>`, so that is what `botUsername` holds and what a mention is
 *   matched against.
 * - **A press is acknowledged through its `response_url`**, an ephemeral note
 *   to the person who pressed. The webhook's own 200 is the press's receipt.
 * - **Commands are plain words**, as on Time: Slack's client claims every
 *   leading `/` for its slash commands.
 */
export class SlackAdapter implements ChatAdapter {
  readonly kind = 'slack' as const;
  readonly limits = { maxChars: MAX_CHARS, maxActionBytes: MAX_ACTION_BYTES };
  readonly inbound = 'webhook' as const;

  /** Each press's `response_url`, by action id, until it is acknowledged. In-process: the press and its handling share one request. */
  private readonly responseUrls = new Map<string, string>();
  /** `<channel>:<ts>` → the thread root, or null for a top-level message. */
  private readonly roots = new Map<string, string | null>();

  constructor(private readonly now: () => number = Date.now) {}

  verifyInbound(raw: RawInbound, _secretHash: string | null, ctx: ChatAdapterContext | null): boolean {
    const secret = ctx?.signingSecret;
    const timestamp = raw.headers['x-slack-request-timestamp'];
    const signature = raw.headers['x-slack-signature'];
    if (!secret || !timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
    if (Math.abs(this.now() / 1000 - Number(timestamp)) > SIGNATURE_MAX_AGE_SEC) return false;
    const a = Buffer.from(slackSignature(secret, timestamp, raw.body));
    const b = Buffer.from(signature);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Slack checking a new Request URL: echo its challenge. Anything else is a delivery. */
  handshake(raw: RawInbound): unknown {
    const body = parseJson<{ type?: string; challenge?: unknown }>(raw.body);
    return body?.type === 'url_verification' && typeof body.challenge === 'string' ? { challenge: body.challenge } : null;
  }

  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[] {
    // A retry after our own timeout is a delivery we already took.
    if (raw.headers['x-slack-retry-reason'] === 'http_timeout') return [];
    if (raw.body.startsWith('payload=')) return this.parsePress(parseJson<SlackActionPayload>(new URLSearchParams(raw.body).get('payload')));
    const body = parseJson<SlackEnvelope>(raw.body);
    const event = body?.type === 'event_callback' ? body.event : undefined;
    if (!event) return [];
    if (event.type === 'reaction_added') return this.parseReaction(event);
    if (event.type !== 'message' || !event.channel) return [];
    // #339: an edit or a delete is followed only by a searchable channel's kept copy, never answered.
    if (event.subtype === 'message_changed' && event.message) {
      return this.parseMessage({ ...event.message, channel: event.channel, channel_type: event.channel_type }, botUsername).map((m) => ({
        ...m,
        change: 'edited' as const,
        ...(tsDate(event.message?.edited?.ts) ? { at: tsDate(event.message?.edited?.ts) } : {}),
      }));
    }
    if (event.subtype === 'message_deleted') return this.parseDeleted(event);
    return this.parseMessage(event, botUsername);
  }

  private parseMessage(m: SlackMessage, botUsername: string | null): ChatInbound[] {
    if (!m.ts || !m.user || !m.channel || m.bot_id || !PERSON_SUBTYPES.has(m.subtype)) return [];
    if (botUsername && m.user === botUsername) return [];
    const isDm = m.channel_type === 'im' || isDmChannel(m.channel);
    const root = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;
    this.remember(m.channel, m.ts, root);
    const mentionRe = botUsername ? new RegExp(`<@${botUsername}(?:\\|[^>]*)?>`, 'g') : null;
    const original = m.text ?? '';
    const mentioned = !!mentionRe && mentionRe.test(original);
    const text = slackPlainText(mentionRe ? original.replace(mentionRe, ' ') : original).replace(/\s+/g, ' ').trim();
    if (!text) return [];
    return [
      {
        externalUserId: m.user,
        externalUserName: null,
        chatId: m.channel,
        chatTitle: null,
        isDm,
        messageId: m.ts,
        text,
        mentioned,
        replyToBotMessageId: root,
        threadId: root ?? (isDm ? null : m.ts),
        // In a channel a command must be addressed, or `help` said to colleagues would summon the bot.
        command: isDm || mentioned ? plainCommand(text) : null,
        action: null,
        ...(tsDate(m.ts) ? { at: tsDate(m.ts) } : {}),
      },
    ];
  }

  private parseDeleted(event: SlackMessage): ChatInbound[] {
    const user = event.previous_message?.user;
    if (!event.deleted_ts || !user || !event.channel) return [];
    return [
      {
        ...blankInbound(user, event.channel),
        messageId: event.deleted_ts,
        ...(tsDate(event.ts) ? { at: tsDate(event.ts) } : {}),
        change: 'deleted',
      },
    ];
  }

  /** `:pushpin:` added to a message (#82): harvest the thread it is in, which `fetchThread` reads. */
  private parseReaction(event: SlackReactionEvent): ChatInbound[] {
    const item = event.item;
    if (event.reaction !== HARVEST_EMOJI || !event.user || item?.type !== 'message' || !item.channel || !item.ts) return [];
    return [
      {
        ...blankInbound(event.user, item.channel),
        messageId: item.ts,
        ...(tsDate(event.event_ts) ? { at: tsDate(event.event_ts) } : {}),
        harvestReaction: true,
      },
    ];
  }

  /** A press of one of our action buttons. A link button's click carries no value, and is nothing to us. */
  private parsePress(press: SlackActionPayload | null): ChatInbound[] {
    const action = press?.actions?.[0];
    const channel = press?.container?.channel_id ?? press?.channel?.id;
    const ts = press?.container?.message_ts ?? press?.message?.ts;
    if (press?.type !== 'block_actions' || !press.user?.id || !channel || !ts || typeof action?.value !== 'string') return [];
    const id = press.trigger_id || randomUUID();
    if (press.response_url && isSlackResponseUrl(press.response_url)) {
      if (this.responseUrls.size >= THREAD_MEMORY) this.responseUrls.clear();
      this.responseUrls.set(id, press.response_url);
    }
    return [{ ...blankInbound(press.user.id, channel), externalUserName: press.user.username ?? null, messageId: ts, action: { id, data: action.value } }];
  }

  render(view: ChatView): ChatOutMessage {
    if (view.kind === 'notice') {
      const text = escapeText(view.text);
      return { text, plain: view.text, buttons: view.button ? [[view.button]] : [] };
    }
    if (view.kind === 'updates') {
      const text = renderUpdates(view);
      return { text, plain: text, buttons: view.button ? [[view.button]] : [] };
    }
    return this.renderAnswer(view);
  }

  private renderAnswer(view: ChatAnswerView): ChatOutMessage {
    const urls = new Map(view.sources.filter((s) => s.cite).map((s) => [s.cite!.toUpperCase(), s.url]));
    const sources = view.sources.length
      ? `\n\n*${escapeText(view.sourcesHeading)}*\n` +
        view.sources.map((s, i) => `${s.cite ? citeNumber(s.cite) : i + 1}. ${link(s.url, s.title)}`).join('\n')
      : '';
    const { text, cut } = cutAnswer(view.answer, MAX_CHARS - ANSWER_HEADROOM - sources.length);
    const body = markdownForSlack(text, (label) => urls.get(label) ?? null, view.webBaseUrl) + sources;
    return { text: body, plain: body, buttons: [...(cut && view.full ? [[view.full]] : []), ...view.actions] };
  }

  async postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef> {
    const root = target.replyToMessageId ? await this.threadFor(ctx, target.chatId, target.replyToMessageId) : null;
    const res = await this.call<{ ts?: string }>(ctx, 'chat.postMessage', {
      channel: target.chatId,
      ...(root ? { thread_ts: root } : {}),
      ...body(msg),
    });
    if (!res.ts) throw new ChatPlatformError('slack chat.postMessage: no ts');
    this.remember(target.chatId, res.ts, root);
    return { chatId: target.chatId, messageId: res.ts };
  }

  async editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void> {
    await this.call(ctx, 'chat.update', { channel: ref.chatId, ts: ref.messageId, ...body(msg) });
  }

  /** The note goes to the person who pressed, through the press's `response_url`; no note, nothing to send. */
  async acknowledge(_ctx: ChatAdapterContext, actionId: string, note?: string): Promise<void> {
    const url = this.responseUrls.get(actionId);
    this.responseUrls.delete(actionId);
    if (!url || !note) return;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', replace_original: false, text: note }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      // The note is a courtesy; the press itself was handled.
    }
  }

  async identify(ctx: ChatAdapterContext): Promise<{ username: string }> {
    const me = await this.call<{ user_id?: string }>(ctx, 'auth.test', {});
    if (!me.user_id) throw new ChatPlatformError('slack auth.test: not a bot token');
    return { username: me.user_id };
  }

  /** Nothing to call: the Request URL is set in the Slack app's settings, and Slack verifies it there ({@link handshake}). */
  async registerWebhook(): Promise<void> {}

  /**
   * `conversations.replies` — the thread, root first, from its root. Asked
   * about a reply, Slack returns that reply alone (carrying its `thread_ts`),
   * so the thread is then read again from the root. Trimmed to what people
   * wrote before the command; a reaction reads it all. The link is
   * `chat.getPermalink`, left out rather than failing the harvest.
   */
  async fetchThread(ctx: ChatAdapterContext, chatId: string, messageId: string, beforeMessageId: string | null, max: number): Promise<ChatThread> {
    const read = (ts: string) =>
      this.call<{ messages?: SlackMessage[] }>(ctx, 'conversations.replies', { channel: chatId, ts, limit: String(THREAD_PAGE) }).then((r) => r.messages ?? []);
    let messages = await read(messageId);
    const root = messages[0]?.thread_ts ?? messageId;
    if (root !== messageId && messages[0]?.ts !== root) messages = await read(root);
    // ponytail: one page of 1000 replies; page by cursor if threads that long ever get harvested
    const cutoff = beforeMessageId ? Number(beforeMessageId) : Infinity;
    const people = messages
      .filter((m) => m.ts && Number(m.ts) < cutoff && m.user && !m.bot_id && PERSON_SUBTYPES.has(m.subtype))
      .map((m) => ({ authorId: m.user!, text: slackPlainText(m.text ?? '').trim(), at: tsDate(m.ts) ?? new Date(0) }))
      .filter((m) => m.text)
      .sort((a, b) => a.at.getTime() - b.at.getTime());
    const kept = people.length > max ? [people[0]!, ...people.slice(people.length - (max - 1))] : people;
    let url: string | null = null;
    try {
      url = (await this.call<{ permalink?: string }>(ctx, 'chat.getPermalink', { channel: chatId, message_ts: root })).permalink ?? null;
    } catch {
      url = null;
    }
    return { messages: kept, url, truncated: kept.length < people.length };
  }

  /** Slack opens a chat with an app only by its app id, which a bot token does not name; a group asks people to message the bot. */
  directLink(): string | null {
    return null;
  }

  /**
   * Where a reply to `messageId` goes: its thread, or a new one under it —
   * except in a direct chat, where a reply to a top-level message stays at
   * the top. Known from the parse in this process; otherwise read.
   */
  private async threadFor(ctx: ChatAdapterContext, chatId: string, messageId: string): Promise<string | null> {
    const key = `${chatId}:${messageId}`;
    let root = this.roots.get(key);
    if (root === undefined) {
      try {
        const [m] = (await this.call<{ messages?: SlackMessage[] }>(ctx, 'conversations.replies', { channel: chatId, ts: messageId, limit: '1' })).messages ?? [];
        root = m?.thread_ts && m.thread_ts !== messageId ? m.thread_ts : null;
      } catch {
        // Gone, or never ours to read: post at the top rather than not at all.
        return null;
      }
    }
    return root ?? (isDmChannel(chatId) ? null : messageId);
  }

  private remember(channel: string, ts: string, root: string | null): void {
    if (this.roots.size >= THREAD_MEMORY) this.roots.clear();
    this.roots.set(`${channel}:${ts}`, root);
  }

  /** One Web API call, form-encoded. Errors carry the method and Slack's error code — never the token. */
  private async call<T = unknown>(ctx: ChatAdapterContext, method: string, params: Record<string, unknown>): Promise<T> {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    let res: Response;
    try {
      res = await fetch(`${SLACK_API}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ChatPlatformError(`slack ${method}: ${err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable'}`);
    }
    if (res.status === 429) throw new ChatPlatformError(`slack ${method}: rate limited`);
    const json = (await res.json().catch(() => null)) as (T & { ok?: boolean; error?: string }) | null;
    if (!res.ok || !json?.ok) {
      const error = json?.error ?? `HTTP ${res.status}`;
      throw new ChatPlatformError(`slack ${method}: ${error}`, error.startsWith('invalid_blocks'));
    }
    return json as T;
  }
}

/** `text` for notifications, `blocks` for what is shown: sections of the text, then one row of buttons per actions block. */
function body(msg: ChatOutMessage): Record<string, unknown> {
  const rows = msg.buttons.filter((r) => r.length);
  const blocks = [
    ...sections(msg.text.slice(0, MAX_CHARS)).map((text) => ({ type: 'section', text: { type: 'mrkdwn', text } })),
    ...rows.map((row, r) => ({ type: 'actions', elements: row.map((b, i) => button(b, `a${r}x${i}`)) })),
  ];
  // Always sent, so an edit that drops the buttons clears them.
  return { text: msg.plain.slice(0, SECTION_CHARS), blocks };
}

function button(b: ChatButton, actionId: string): Record<string, unknown> {
  const text = { type: 'plain_text', text: b.label.slice(0, 75), emoji: true };
  return 'url' in b ? { type: 'button', action_id: actionId, text, url: b.url } : { type: 'button', action_id: actionId, text, value: (b as ChatActionButton).action };
}

function blankInbound(user: string, channel: string): ChatInbound {
  return {
    externalUserId: user,
    externalUserName: null,
    chatId: channel,
    chatTitle: null,
    isDm: isDmChannel(channel),
    messageId: '',
    text: '',
    mentioned: false,
    replyToBotMessageId: null,
    threadId: null,
    command: null,
    action: null,
  };
}

/** A press's `response_url` is Slack's, or it is not followed: the payload is signed, but the address is still where we would POST. */
function isSlackResponseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.hostname === 'hooks.slack.com';
  } catch {
    return false;
  }
}

/** An Events API delivery. */
interface SlackEnvelope {
  type?: string;
  event?: SlackMessage & SlackReactionEvent;
}

interface SlackMessage {
  type?: string;
  subtype?: string;
  channel?: string;
  /** `channel` public, `group` private, `im` direct, `mpim` group direct. */
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  /** The thread's root; equal to `ts` on the root itself. */
  thread_ts?: string;
  edited?: { ts?: string };
  /** `message_changed`: the message as it is now. */
  message?: SlackMessage;
  /** `message_deleted`. */
  deleted_ts?: string;
  previous_message?: { user?: string };
}

interface SlackReactionEvent {
  type?: string;
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
  event_ts?: string;
}

/** Interactivity's `block_actions` payload, the parts read. */
interface SlackActionPayload {
  type?: string;
  user?: { id?: string; username?: string };
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string };
  message?: { ts?: string };
  trigger_id?: string;
  response_url?: string;
  actions?: Array<{ action_id?: string; value?: unknown }>;
}
