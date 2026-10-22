import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatPlatformKind } from '@knowledge/contracts';
import { CITE_MARKER_RE } from '../../assistant/citations.js';
import { safeFetch } from '../../common/safe-fetch.js';
import {
  ChatPlatformError,
  type ChatActionButton,
  type ChatAdapter,
  type ChatAdapterContext,
  type ChatAnswerView,
  type ChatButton,
  type ChatInbound,
  type ChatLinkButton,
  type ChatMessageRef,
  type ChatOutMessage,
  type ChatTarget,
  type ChatThread,
  type ChatUpdatesView,
  type ChatView,
  type RawInbound,
} from './chat-adapter.types.js';
import { cutAnswer } from './telegram.adapter.js';

/** Mattermost's post limit is 16 383 characters; the rest is room for the sources block. */
const MAX_CHARS = 16_000;
/** Button data travels in `integration.context`, which has no small cap; this keeps a post's props modest. */
const MAX_ACTION_BYTES = 256;
const ANSWER_HEADROOM = 400;
const CALL_TIMEOUT_MS = 15_000;
/**
 * How long a press's HTTP response waits for the core to acknowledge it. The
 * core acknowledges after a vote is stored — milliseconds — and long work (a
 * capture) is started after the acknowledgement, never before.
 */
const ACK_WAIT_MS = 5_000;
/** Commands as a whole message: a Mattermost client takes a leading `/` as its own slash command. */
const COMMAND_RE = /^\/?(start|help|new|unlink|bind|unbind|capture|remember|запомни)$/i;
/** Asking the bot to remember a thread is `capture` (#82), in either language. */
const CAPTURE_WORDS = new Set(['capture', 'remember', 'запомни']);
/** The reaction that asks for a harvest (#82): 📌, by its Mattermost name. */
const HARVEST_EMOJI = 'pushpin';
/** A direct channel's name is the two user ids joined by `__`; a press carries the name, not the type. */
const DM_CHANNEL_NAME_RE = /^[a-z0-9]+__[a-z0-9]+$/;
/** Direct channels seen, so a reply there stays out of a thread. Bounded: forgotten ones only thread. */
const DM_MEMORY = 5_000;

/**
 * The key a button's signature is made with: derived from the bot's token, the
 * one secret this API and the messenger's server share. A new token is a new bot, and
 * the old bot's buttons stop verifying with it — which is what they should do.
 */
function actionKey(token: string): Buffer {
  return createHash('sha256').update(`chat-action\0${token}`, 'utf8').digest();
}

export function signAction(data: string, token: string): string {
  return createHmac('sha256', actionKey(token)).update(data, 'utf8').digest('base64url');
}

function verifyAction(data: string, signature: string, token: string): boolean {
  const a = Buffer.from(signAction(data, token));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A post's permalink, which opens it in its thread for the channel's members.
 * Stateless, so chat search (#407) links a window from the team kept on its
 * binding without an adapter or a platform call.
 */
export function mattermostPermalink(serverUrl: string, team: string, postId: string): string {
  return `${serverUrl.replace(/\/$/, '')}/${encodeURIComponent(team)}/pl/${encodeURIComponent(postId)}`;
}

/**
 * A command said as a whole message in plain words (`help`, `capture`…): a
 * Mattermost client, like Slack's, takes every leading `/` for its own slash
 * commands and never posts it. `remember` and `запомни` are `capture`.
 */
export function plainCommand(text: string): { name: string; args: string } | null {
  const match = COMMAND_RE.exec(text);
  if (!match) return null;
  const name = match[1].toLowerCase();
  return { name: CAPTURE_WORDS.has(name) ? 'capture' : name, args: '' };
}

/** `S3` → `3`: the reader sees a footnote number, not the model's label. */
export const citeNumber = (label: string): string => label.replace(/^S/i, '');

/** `[text](url)`, the URL allowed one level of parentheses — the Telegram adapter's pattern. */
export const MD_LINK_RE = /\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

/** Link text that came from a page title: brackets would end the link early. */
const escapeLinkText = (s: string): string => s.replace(/([[\]\\])/g, '\\$1');

/**
 * `@name` → `@​name`. Answers quote pages and titles are typed by people,
 * and on Mattermost `@channel`, `@all` or a colleague's handle in either would ping
 * them. A zero-width space after the `@` keeps the text and drops the mention.
 * An `@` inside a URL (after `/`, `:` or a word character) is left alone.
 */
export function defuseMentions(text: string): string {
  return text.replace(/(^|[^\w/:.@])@(?=[\w])/g, '$1@​');
}

export function resolveUrl(raw: string, base: string): string | null {
  try {
    const url = new URL(raw, base.endsWith('/') ? base : `${base}/`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * An answer's markdown as Mattermost renders it. It speaks markdown already, so
 * this only does what a chat client cannot: resolve relative page links, turn
 * `[S#]` into numbered links to the source, drop links that are not http(s),
 * and defuse mentions. Code fences pass through untouched.
 */
export function markdownForMattermost(md: string, cite: (label: string) => string | null, base: string): string {
  const parts = md.split(/(```[^\n]*\n[\s\S]*?```)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let s = part.replace(MD_LINK_RE, (_, text: string, href: string) => {
        const url = resolveUrl(href, base);
        return url ? `[${text}](${url})` : text;
      });
      s = s.replace(new RegExp(CITE_MARKER_RE.source, 'gi'), (_, labels: string) =>
        labels
          .split(/\s*[,;]\s*/)
          .map((label) => {
            const url = cite(label.toUpperCase());
            const n = citeNumber(label);
            // The brackets escaped, so the link reads "[2]" rather than "2".
            return url ? `[\\[${n}\\]](${url})` : `[${n}]`;
          })
          .join(''),
      );
      return defuseMentions(s);
    })
    .join('')
    .trim();
}

function renderUpdates(view: ChatUpdatesView): string {
  const lines = view.items.map((i) => `- ${defuseMentions(i.label)}: [${escapeLinkText(defuseMentions(i.title))}](${i.url})`);
  if (view.more) lines.push(defuseMentions(view.more));
  return [...(view.heading ? [`**${defuseMentions(view.heading)}**`] : []), ...lines].join('\n').slice(0, MAX_CHARS);
}

/** Link buttons become a line of links: Mattermost's buttons only call back, they never open a URL. */
function linkLine(rows: ChatButton[][]): string {
  return rows
    .flat()
    .filter((b): b is ChatLinkButton => 'url' in b)
    .map((b) => `[${escapeLinkText(b.label)}](${b.url})`)
    .join(' · ');
}

/** The platforms that speak Mattermost's `/api/v4`: Mattermost itself, and Time. */
export type MattermostKind = Extract<ChatPlatformKind, 'mattermost' | 'time'>;

/**
 * Mattermost (#343) and Time (issue #71, phase 4) — T-Bank's corporate
 * messenger, which is Mattermost's `/api/v4` under another name. Both are
 * self-hosted per customer, so this is one implementation and the kind is a
 * constructor argument: it names the platform in errors and in the registry,
 * and nothing else differs. Plain `fetch` again, through the SSRF-guarded one
 * because the server is an address an admin typed.
 *
 * What differs from Telegram, and where it went:
 *
 * - **Messages arrive over the bot's websocket** (`posted` events), held by
 *   `ChatSocketSupervisor`; there is no webhook to register.
 * - **Real threads.** In a channel the bot answers in the question's thread
 *   (`root_id`), and the thread is the conversation (`ChatInbound.threadId`).
 *   In a direct chat it answers at the top, as a person would, unless asked
 *   inside a thread.
 * - **Buttons call our URL** (`integration.url`) with whatever `context` they
 *   were given, and nothing on the request proves who sent it — so the context
 *   carries an HMAC over the data, keyed by the token, checked in
 *   {@link verifyInbound}.
 * - **The press is answered in the HTTP response** (`ephemeral_text`), not by a
 *   later call: {@link respondToAction} holds the response until the core's
 *   {@link acknowledge}.
 * - **Commands are plain words.** The client claims every leading `/`, so
 *   `help`, `new`, `bind`… are read as a whole message on their own.
 */
export class MattermostAdapter implements ChatAdapter {
  readonly limits = { maxChars: MAX_CHARS, maxActionBytes: MAX_ACTION_BYTES };
  readonly inbound = 'socket' as const;

  /** Presses waiting for their acknowledgement, by action id. In-process: the press and its handling share one request. */
  private readonly pendingAcks = new Map<string, (note?: string) => void>();
  private readonly dmChannels = new Set<string>();

  constructor(
    readonly kind: MattermostKind,
    private readonly allowPrivate: boolean,
  ) {}

  /**
   * Only a button press is ever POSTed to the webhook, so only a correctly
   * signed one verifies. A `posted` event pushed at the webhook by somebody
   * else carries no signature and is refused like any other forgery.
   */
  verifyInbound(raw: RawInbound, _secretHash: string | null, ctx: ChatAdapterContext | null): boolean {
    if (!ctx) return false;
    const press = parseJson<MattermostActionRequest>(raw.body);
    const context = press?.context;
    if (typeof context?.a !== 'string' || typeof context.s !== 'string') return false;
    return verifyAction(context.a, context.s, ctx.token);
  }

  /**
   * A press (from the webhook, already verified) or a websocket event (from
   * the supervisor). A body with a `context` is only ever read as a press, so
   * a signed press cannot smuggle a message along with it.
   */
  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[] {
    const body = parseJson<MattermostActionRequest & MattermostEvent>(raw.body);
    if (!body) return [];
    if (body.context) return this.parsePress(body);
    if (body.event === 'posted') return this.parsePosted(body, botUsername);
    if (body.event === 'reaction_added') return this.parseReaction(body);
    // #339: followed only by a searchable channel's kept copy, never answered.
    if (body.event === 'post_edited') return this.parsePosted(body, botUsername).map((m) => ({ ...m, change: 'edited' as const }));
    if (body.event === 'post_deleted') return this.parseDeleted(body);
    return [];
  }

  /**
   * 📌 (`pushpin`) added to a post (#82): harvest the thread it is in. The
   * event carries the post's id and no text, which `fetchThread` reads anyway.
   * Whether the channel is a direct one is known only if the bot has seen it.
   */
  private parseReaction(event: MattermostEvent): ChatInbound[] {
    const r = parseJson<{ user_id?: string; post_id?: string; channel_id?: string; emoji_name?: string; create_at?: number }>(
      event.data?.reaction,
    );
    const chatId = r?.channel_id;
    if (r?.emoji_name !== HARVEST_EMOJI || !r.user_id || !r.post_id || !chatId) return [];
    return [
      {
        externalUserId: r.user_id,
        externalUserName: null,
        chatId,
        chatTitle: null,
        isDm: this.dmChannels.has(chatId),
        messageId: r.post_id,
        text: '',
        mentioned: false,
        replyToBotMessageId: null,
        threadId: null,
        command: null,
        action: null,
        ...(r.create_at ? { at: new Date(r.create_at) } : {}),
        harvestReaction: true,
      },
    ];
  }

  private parsePosted(event: MattermostEvent, botUsername: string | null): ChatInbound[] {
    const post = parseJson<MattermostPost>(event.data?.post);
    if (!post?.id || !post.user_id || !post.channel_id) return [];
    // System messages (joins, header changes) and anything a bot wrote — this one included.
    if (post.type || post.props?.from_bot === 'true' || post.props?.from_bot === true) return [];
    const bot = botUsername?.toLowerCase() ?? null;
    const sender = event.data?.sender_name?.replace(/^@/, '').toLowerCase();
    if (bot && sender === bot) return [];
    const original = (post.message ?? '').trim();
    if (!original) return [];

    const isDm = event.data?.channel_type === 'D';
    if (isDm) this.rememberDm(post.channel_id);
    const mentionRe = bot ? new RegExp(`(^|[^\\w.@-])@${escapeRegex(bot)}(?![\\w-]|\\.\\w)`, 'gi') : null;
    const mentioned = !!mentionRe && mentionRe.test(original);
    const text = (mentionRe ? original.replace(mentionRe, '$1') : original).replace(/\s+/g, ' ').trim();
    const root = post.root_id || null;

    return [
      {
        externalUserId: post.user_id,
        externalUserName: event.data?.sender_name ?? null,
        chatId: post.channel_id,
        chatTitle: event.data?.channel_display_name ?? null,
        isDm,
        messageId: post.id,
        text,
        mentioned,
        replyToBotMessageId: root,
        threadId: root ?? (isDm ? null : post.id),
        // In a channel a command must be addressed, or `help` said to colleagues would summon the bot.
        command: isDm || mentioned ? plainCommand(text) : null,
        action: null,
        // An edit's time is the edit's; a post's, its creation.
        ...(post.edit_at || post.create_at ? { at: new Date(post.edit_at || post.create_at!) } : {}),
      },
    ];
  }

  private parseDeleted(event: MattermostEvent): ChatInbound[] {
    const post = parseJson<MattermostPost>(event.data?.post);
    if (!post?.id || !post.user_id || !post.channel_id) return [];
    return [
      {
        externalUserId: post.user_id,
        externalUserName: null,
        chatId: post.channel_id,
        chatTitle: null,
        isDm: event.data?.channel_type === 'D',
        messageId: post.id,
        text: '',
        mentioned: false,
        replyToBotMessageId: null,
        threadId: null,
        command: null,
        action: null,
        ...(post.delete_at ? { at: new Date(post.delete_at) } : {}),
        change: 'deleted',
      },
    ];
  }

  private parsePress(press: MattermostActionRequest): ChatInbound[] {
    const data = press.context?.a;
    if (!press.user_id || !press.channel_id || !press.post_id || typeof data !== 'string') return [];
    const isDm = DM_CHANNEL_NAME_RE.test(press.channel_name ?? '');
    if (isDm) this.rememberDm(press.channel_id);
    return [
      {
        externalUserId: press.user_id,
        externalUserName: press.user_name ? `@${press.user_name}` : null,
        chatId: press.channel_id,
        chatTitle: null,
        isDm,
        messageId: press.post_id,
        text: '',
        mentioned: false,
        replyToBotMessageId: null,
        threadId: null,
        command: null,
        // trigger_id is per press; the fallback only has to be unique in this process.
        action: { id: press.trigger_id || randomUUID(), data },
      },
    ];
  }

  render(view: ChatView): ChatOutMessage {
    if (view.kind === 'notice') {
      const text = defuseMentions(view.text);
      return { text, plain: text, buttons: view.button ? [[view.button]] : [] };
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
      ? `\n\n**${view.sourcesHeading}**\n` +
        view.sources
          .map((s, i) => `${s.cite ? citeNumber(s.cite) : i + 1}. [${escapeLinkText(defuseMentions(s.title))}](${s.url})`)
          .join('\n')
      : '';
    const { text, cut } = cutAnswer(view.answer, MAX_CHARS - ANSWER_HEADROOM - sources.length);
    const body = markdownForMattermost(text, (label) => urls.get(label) ?? null, view.webBaseUrl) + sources;
    return { text: body, plain: body, buttons: [...(cut && view.full ? [[view.full]] : []), ...view.actions] };
  }

  async postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef> {
    const rootId = target.replyToMessageId ? await this.threadFor(ctx, target.chatId, target.replyToMessageId) : null;
    const post = await this.call<{ id: string }>(ctx, 'POST', '/posts', {
      channel_id: target.chatId,
      ...(rootId ? { root_id: rootId } : {}),
      ...this.body(ctx, msg),
    });
    return { chatId: target.chatId, messageId: post.id };
  }

  async editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void> {
    await this.call(ctx, 'PUT', `/posts/${encodeURIComponent(ref.messageId)}/patch`, this.body(ctx, msg));
  }

  /** Hands the note to the press's waiting HTTP response. A press already answered (timed out) keeps its silence. */
  async acknowledge(_ctx: ChatAdapterContext, actionId: string, note?: string): Promise<void> {
    this.pendingAcks.get(actionId)?.(note);
  }

  async respondToAction(inbound: ChatInbound, handled: Promise<void>): Promise<unknown> {
    const id = inbound.action?.id;
    if (!id) return undefined;
    const note = await new Promise<string | undefined>((resolve) => {
      this.pendingAcks.set(id, resolve);
      void handled.then(
        () => resolve(undefined),
        () => resolve(undefined),
      );
      setTimeout(() => resolve(undefined), ACK_WAIT_MS).unref();
    }).finally(() => this.pendingAcks.delete(id));
    // An empty object leaves the post as it is: any change to it is the core's own edit.
    return note ? { ephemeral_text: note } : {};
  }

  async identify(ctx: ChatAdapterContext): Promise<{ username: string }> {
    const me = await this.call<{ username?: string }>(ctx, 'GET', '/users/me');
    if (!me.username) throw new ChatPlatformError('users/me returned no username');
    return { username: me.username };
  }

  /** Nothing to register: the supervisor opens the bot's websocket once the row is saved and enabled. */
  async registerWebhook(): Promise<void> {}

  /**
   * Mattermost has no link that opens a private chat without knowing the team, which
   * a bot does not have. The group is told to message the bot instead.
   */
  directLink(): string | null {
    return null;
  }

  /**
   * `GET /posts/:id/thread` — the whole thread in one call, from any post in
   * it — trimmed to what people wrote before the command (a reaction has none,
   * and reads it all). The link is the root's permalink, which needs the
   * team's name: one call for the channel's team, one for the team. A link
   * that cannot be built is left out rather than failing the harvest.
   */
  async fetchThread(
    ctx: ChatAdapterContext,
    chatId: string,
    messageId: string,
    beforeMessageId: string | null,
    max: number,
  ): Promise<ChatThread> {
    const thread = await this.call<{ posts?: Record<string, MattermostPost & { create_at?: number }> }>(
      ctx,
      'GET',
      `/posts/${encodeURIComponent(messageId)}/thread`,
    );
    const posts = Object.values(thread.posts ?? {});
    const rootId = posts.find((p) => p.id === messageId)?.root_id || messageId;
    const cutoff = posts.find((p) => p.id === beforeMessageId)?.create_at ?? Infinity;
    const people = posts
      .filter((p) => p.id !== beforeMessageId && (p.create_at ?? 0) < cutoff)
      .filter((p) => !p.type && p.props?.from_bot !== 'true' && p.props?.from_bot !== true && p.message?.trim() && p.user_id)
      .sort((a, b) => (a.create_at ?? 0) - (b.create_at ?? 0));
    const kept = people.length > max ? [people[0]!, ...people.slice(people.length - (max - 1))] : people;
    return {
      messages: kept.map((p) => ({ authorId: p.user_id!, text: p.message!.trim(), at: new Date(p.create_at ?? 0) })),
      url: await this.permalink(ctx, chatId, rootId),
      truncated: kept.length < people.length,
    };
  }

  private async permalink(ctx: ChatAdapterContext, chatId: string, postId: string): Promise<string | null> {
    try {
      const team = await this.chatTeam(ctx, chatId);
      return team ? mattermostPermalink(ctx.serverUrl!, team, postId) : null;
    } catch {
      return null;
    }
  }

  /** The name of the team a channel is in: one call for the channel, one for its team. */
  async chatTeam(ctx: ChatAdapterContext, chatId: string): Promise<string | null> {
    const channel = await this.call<{ team_id?: string }>(ctx, 'GET', `/channels/${encodeURIComponent(chatId)}`);
    // A direct channel belongs to no team, and a permalink needs one.
    if (!channel.team_id) return null;
    const team = await this.call<{ name?: string }>(ctx, 'GET', `/teams/${encodeURIComponent(channel.team_id)}`);
    return team.name || null;
  }

  /** The websocket URL for a server: the API's own origin and path, over ws(s). */
  socketUrl(serverUrl: string): string {
    const url = new URL(`${serverUrl.replace(/\/$/, '')}/api/v4/websocket`);
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    return url.toString();
  }

  /**
   * Where a reply to `messageId` goes: the thread that message is in, or a new
   * one under it — except in a direct chat, where a reply to a top-level
   * message stays at the top. The server refuses a `root_id` that is itself a reply,
   * so the message is read for its root rather than used as one.
   */
  private async threadFor(ctx: ChatAdapterContext, chatId: string, messageId: string): Promise<string | null> {
    let root: string | null;
    try {
      const post = await this.call<{ root_id?: string }>(ctx, 'GET', `/posts/${encodeURIComponent(messageId)}`);
      root = post.root_id || null;
    } catch {
      // Gone (deleted, or never ours to read): post at the top rather than not at all.
      return null;
    }
    return root ?? (this.dmChannels.has(chatId) ? null : messageId);
  }

  /** `message` plus buttons. Each row of action buttons is one attachment, which is what lays them out in rows. */
  private body(ctx: ChatAdapterContext, msg: ChatOutMessage): Record<string, unknown> {
    const links = linkLine(msg.buttons);
    const rows = msg.buttons.map((row) => row.filter((b): b is ChatActionButton => !('url' in b))).filter((r) => r.length);
    const attachments = rows.map((row, r) => ({
      actions: row.map((b, i) => ({
        // Latin letters and digits only, unique within the post.
        id: `a${r}x${i}`,
        name: b.label,
        type: 'button',
        integration: { url: ctx.actionUrl, context: { a: b.action, s: signAction(b.action, ctx.token) } },
      })),
    }));
    return {
      message: [msg.text, links].filter(Boolean).join('\n\n').slice(0, MAX_CHARS),
      // Always sent, so an edit that drops the buttons clears them.
      props: { attachments },
    };
  }

  private rememberDm(channelId: string): void {
    if (this.dmChannels.size >= DM_MEMORY) this.dmChannels.clear();
    this.dmChannels.add(channelId);
  }

  /** One API call. Errors carry the platform, the method, the path and the server's message — never the token. */
  private async call<T = unknown>(ctx: ChatAdapterContext, method: string, path: string, body?: unknown): Promise<T> {
    if (!ctx.serverUrl) throw new ChatPlatformError(`${this.kind}: no server address`);
    const label = `${this.kind} ${method} ${path.replace(/\/[a-z0-9]{26}(?=\/|$)/g, '/:id')}`;
    let res: Response;
    try {
      res = await safeFetch(
        `${ctx.serverUrl.replace(/\/$/, '')}/api/v4${path}`,
        {
          method,
          headers: {
            authorization: `Bearer ${ctx.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        },
        this.allowPrivate,
      );
    } catch (err) {
      const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'unreachable';
      throw new ChatPlatformError(`${label}: ${reason}`);
    }
    const json = (await res.json().catch(() => null)) as (T & { message?: string }) | null;
    if (!res.ok) throw new ChatPlatformError(`${label}: ${json?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }
}

export function parseJson<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A websocket event: `posted` carries the post as a JSON string, Mattermost's shape. */
interface MattermostEvent {
  event?: string;
  data?: {
    post?: string;
    /** `reaction_added`: the Reaction as a JSON string — user, post, channel, emoji name. */
    reaction?: string;
    /** `D` direct, `G` group direct, `O` public, `P` private. */
    channel_type?: string;
    channel_display_name?: string;
    sender_name?: string;
  };
  broadcast?: { channel_id?: string; team_id?: string };
  seq?: number;
}

interface MattermostPost {
  id?: string;
  user_id?: string;
  channel_id?: string;
  root_id?: string;
  message?: string;
  /** Non-empty for system messages (`system_join_channel`, …). */
  type?: string;
  props?: { from_bot?: string | boolean };
  /** Epoch milliseconds; 0 when unset. */
  create_at?: number;
  edit_at?: number;
  delete_at?: number;
}

/** What the server POSTs to a button's `integration.url` (`PostActionIntegrationRequest`). */
interface MattermostActionRequest {
  user_id?: string;
  user_name?: string;
  channel_id?: string;
  channel_name?: string;
  team_id?: string;
  post_id?: string;
  trigger_id?: string;
  context?: { a?: unknown; s?: unknown };
}
