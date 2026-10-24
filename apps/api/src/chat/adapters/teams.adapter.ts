import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
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
  type ChatUpdatesView,
  type ChatView,
  type RawInbound,
} from './chat-adapter.types.js';
import { citeNumber, defuseMentions, markdownForMattermost, parseJson, plainCommand } from './mattermost.adapter.js';
import { cutAnswer } from './telegram.adapter.js';

/** Bot Framework's signing keys, and who signs a delivery to a bot. */
const BOT_FRAMEWORK_JWKS = 'https://login.botframework.com/v1/.well-known/keys';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
/** The global service URL, for a conversation this process has not heard from yet. */
const GLOBAL_SERVICE_URL = 'https://smba.trafficmanager.net/teams/';
/** Service URLs we post to: Bot Framework's own hosts only, never one a payload names freely. */
const SERVICE_HOST_RE = /(^|\.)(trafficmanager\.net|botframework\.com)$/i;
const MAX_CHARS = 20_000;
const MAX_ACTION_BYTES = 2000;
const ANSWER_HEADROOM = 400;
const CALL_TIMEOUT_MS = 15_000;
/** Conversations and messages this process has seen, so a reply or an edit finds its place without a call. */
const MEMORY = 5_000;

/**
 * The credential, as the setup form joins it: `<app id>:<tenant id>:<client
 * secret>`. A Bot Framework bot is an Entra app registration, and new bots are
 * single-tenant, so all three are needed to get a token. A secret holds no `:`.
 */
export function teamsCredential(token: string): { appId: string; tenantId: string; secret: string } | null {
  const [appId, tenantId, ...rest] = token.split(':');
  const secret = rest.join(':');
  return appId && tenantId && secret ? { appId: appId.trim(), tenantId: tenantId.trim(), secret } : null;
}

/** A channel thread's conversation id is the channel's with `;messageid=<root>`; a chat's has none. */
export function splitConversation(id: string): { chatId: string; root: string | null } {
  const at = id.indexOf(';messageid=');
  return at < 0 ? { chatId: id, root: null } : { chatId: id.slice(0, at), root: id.slice(at + ';messageid='.length) || null };
}

/** Teams' message text: HTML-ish, with `<at>` around mentions. The bot's own mentions removed, the rest read as text. */
export function teamsText(html: string, botMentions: string[]): string {
  let s = html;
  for (const m of botMentions) s = s.split(m).join(' ');
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function renderUpdates(view: ChatUpdatesView): string {
  const lines = view.items.map((i) => `- ${defuseMentions(i.label)}: [${defuseMentions(i.title).replace(/[[\]]/g, '')}](${i.url})`);
  if (view.more) lines.push(defuseMentions(view.more));
  return [...(view.heading ? [`**${defuseMentions(view.heading)}**`] : []), ...lines].join('\n\n').slice(0, MAX_CHARS);
}

/**
 * Microsoft Teams (#381), through the Bot Framework: an Azure Bot whose
 * messaging endpoint is our webhook, and a Teams app package that installs it.
 *
 * - **Every activity is a signed JWT** from Bot Framework
 *   (`Authorization: Bearer`), checked against its published keys, issuer and
 *   our app id as audience, and its `serviceurl` claim against the activity's
 *   — {@link verifyInbound}. That is the only proof a delivery has, so a
 *   button needs no signature of its own.
 * - **Hearing a channel.** The app manifest asks for the resource-specific
 *   permission `ChannelMessage.Read.Group`, granted by the team owner at
 *   install: the bot then receives every message of the channels in that
 *   team, not only mentions — which is what lets a channel keep its messages
 *   for `capture` (the listening buffer, as on Telegram). Without listening a
 *   harvest has nothing to read, and the bot says so. No Graph call, so no
 *   protected-API approval.
 * - **Threads.** A channel thread is `<channel>;messageid=<root>` as a
 *   conversation id. The channel is the chat a binding names; the root is the
 *   thread, and the topic its kept messages are filed under, so a `capture`
 *   in a thread reads that thread from the buffer.
 * - **Outbound** needs an Entra token (client credentials, single tenant) and
 *   the conversation's service URL, remembered from its activities.
 * - **Buttons** are an Adaptive Card under the text; a press comes back as a
 *   message whose `value` is the button's data. Teams has no note shown to the
 *   presser alone, so {@link acknowledge} is silent; the core re-renders the
 *   message itself.
 * - **Commands are plain words**, as on Time and Slack.
 */
export class TeamsAdapter implements ChatAdapter {
  readonly kind = 'teams' as const;
  readonly limits = { maxChars: MAX_CHARS, maxActionBytes: MAX_ACTION_BYTES };
  readonly inbound = 'webhook' as const;

  private readonly keys: JWTVerifyGetKey;
  private readonly serviceUrls = new Map<string, string>();
  /** A message's full conversation id (a thread's included), for replies under it and edits of it. */
  private readonly conversations = new Map<string, string>();
  private readonly tokens = new Map<string, { value: string; until: number }>();

  constructor(keys?: JWTVerifyGetKey) {
    this.keys = keys ?? createRemoteJWKSet(new URL(BOT_FRAMEWORK_JWKS), { timeoutDuration: CALL_TIMEOUT_MS });
  }

  async verifyInbound(raw: RawInbound, _secretHash: string | null, ctx: ChatAdapterContext | null): Promise<boolean> {
    const cred = ctx ? teamsCredential(ctx.token) : null;
    const bearer = /^Bearer (.+)$/i.exec(raw.headers.authorization ?? '')?.[1];
    if (!cred || !bearer) return false;
    try {
      const { payload } = await jwtVerify(bearer, this.keys, { issuer: BOT_FRAMEWORK_ISSUER, audience: cred.appId, clockTolerance: 300 });
      const activity = parseJson<TeamsActivity>(raw.body);
      // ponytail: the JWK's `endorsements` (channel ids) are not checked; jose does not expose them, and issuer + audience + serviceurl already bind the token to this bot
      return !!activity?.serviceUrl && payload.serviceurl === activity.serviceUrl;
    } catch {
      return false;
    }
  }

  parseInbound(raw: RawInbound, botUsername: string | null): ChatInbound[] {
    const a = parseJson<TeamsActivity>(raw.body);
    if (!a?.id || !a.conversation?.id || !a.from?.id) return [];
    const { chatId, root } = splitConversation(a.conversation.id);
    const isDm = a.conversation.conversationType === 'personal';
    if (a.serviceUrl && isServiceUrl(a.serviceUrl)) this.remember(this.serviceUrls, chatId, a.serviceUrl);
    const self = a.recipient?.id ?? (botUsername ? `28:${botUsername}` : null);
    if (a.from.id === self) return [];
    const base: ChatInbound = {
      externalUserId: a.from.aadObjectId ?? a.from.id,
      externalUserName: a.from.name ?? null,
      chatId,
      chatTitle: a.channelData?.channel?.name ?? a.conversation.name ?? null,
      isDm,
      messageId: a.id,
      text: '',
      mentioned: false,
      replyToBotMessageId: null,
      threadId: null,
      command: null,
      action: null,
      ...(a.timestamp ? { at: new Date(a.timestamp) } : {}),
    };

    // A press of one of our Adaptive Card buttons: `value` is the data we put there.
    if (a.type === 'message' && a.value && typeof a.value === 'object' && typeof (a.value as { a?: unknown }).a === 'string' && a.replyToId) {
      this.remember(this.conversations, a.replyToId, a.conversation.id);
      return [{ ...base, messageId: a.replyToId, action: { id: a.id, data: (a.value as { a: string }).a } }];
    }
    // #339: an edit or a delete reaches only a searchable channel's kept copy.
    if (a.type === 'messageDelete') return [{ ...base, change: 'deleted' }];
    const edited = a.type === 'messageUpdate';
    if (a.type !== 'message' && !edited) return [];

    const mentions = (a.entities ?? []).filter((e) => e.type === 'mention' && e.mentioned?.id === self).map((e) => e.text ?? '');
    const text = teamsText(a.text ?? '', mentions.filter(Boolean));
    if (!text) return [];
    // A channel post is its own thread's root; a reply names its root in the conversation id.
    // A chat — one-to-one or a group — has no threads.
    const channel = isChannel(chatId);
    const thread = channel ? (root ?? a.id) : null;
    // Where a reply to it goes: its thread in a channel (a root post's own, too), else its chat.
    this.remember(this.conversations, a.id, thread ? `${chatId};messageid=${thread}` : a.conversation.id);
    const mentioned = mentions.length > 0;
    return [
      {
        ...base,
        text,
        mentioned,
        replyToBotMessageId: root,
        threadId: thread,
        // The thread is the topic its kept messages are filed under.
        topicId: thread,
        // In a channel thread, `capture` reads from the root on: the root's text is in the buffer, not here.
        ...(channel && root ? { replyTo: { messageId: root, authorId: '', text: '', at: new Date(0), fromBot: false } } : {}),
        command: isDm || mentioned ? plainCommand(text) : null,
        ...(edited ? { change: 'edited' as const } : {}),
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
      ? `\n\n**${defuseMentions(view.sourcesHeading)}**\n\n` +
        view.sources
          .map((s, i) => `${s.cite ? citeNumber(s.cite) : i + 1}. [${defuseMentions(s.title).replace(/[[\]]/g, '')}](${s.url})`)
          .join('\n')
      : '';
    const { text, cut } = cutAnswer(view.answer, MAX_CHARS - ANSWER_HEADROOM - sources.length);
    const body = markdownForMattermost(text, (label) => urls.get(label) ?? null, view.webBaseUrl) + sources;
    return { text: body, plain: body, buttons: [...(cut && view.full ? [[view.full]] : []), ...view.actions] };
  }

  async postMessage(ctx: ChatAdapterContext, target: ChatTarget, msg: ChatOutMessage): Promise<ChatMessageRef> {
    // A reply goes into its message's thread, or starts one under a channel post; a chat has no threads.
    const known = target.replyToMessageId ? this.conversations.get(target.replyToMessageId) : undefined;
    const conversation = known ?? (target.replyToMessageId && isChannel(target.chatId) ? `${target.chatId};messageid=${target.replyToMessageId}` : target.chatId);
    const res = await this.call<{ id?: string }>(ctx, target.chatId, 'POST', `/v3/conversations/${encodeURIComponent(conversation)}/activities`, activity(msg));
    if (!res.id) throw new ChatPlatformError('teams send: no activity id');
    this.remember(this.conversations, res.id, conversation);
    return { chatId: target.chatId, messageId: res.id };
  }

  async editMessage(ctx: ChatAdapterContext, ref: ChatMessageRef, msg: ChatOutMessage): Promise<void> {
    const conversation = this.conversations.get(ref.messageId) ?? ref.chatId;
    await this.call(ctx, splitConversation(conversation).chatId, 'PUT', `/v3/conversations/${encodeURIComponent(conversation)}/activities/${encodeURIComponent(ref.messageId)}`, {
      id: ref.messageId,
      ...activity(msg),
    });
  }

  /** Teams has no note shown only to the presser; the core's own edit is the answer to a press. */
  async acknowledge(): Promise<void> {}

  /** A token for the app is the proof the three halves of the credential belong together; the bot is its app id. */
  async identify(ctx: ChatAdapterContext): Promise<{ username: string }> {
    const cred = teamsCredential(ctx.token);
    if (!cred) throw new ChatPlatformError('teams: the credential must be app id, tenant id and client secret');
    await this.token(cred);
    return { username: cred.appId };
  }

  /** Nothing to call: the messaging endpoint is set on the Azure Bot. */
  async registerWebhook(): Promise<void> {}

  /** A channel message's link, which opens it in Teams for the channel's members; a chat has none. */
  messageUrl(chatId: string, messageId: string): string | null {
    return isChannel(chatId) ? `https://teams.microsoft.com/l/message/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}` : null;
  }

  /** Opens a chat with the bot by its app id. */
  directLink(botUsername: string | null): string | null {
    return botUsername ? `https://teams.microsoft.com/l/chat/0/0?users=28:${encodeURIComponent(botUsername)}` : null;
  }

  private async token(cred: { appId: string; tenantId: string; secret: string }): Promise<string> {
    const hit = this.tokens.get(cred.appId);
    if (hit && hit.until > Date.now()) return hit.value;
    let res: Response;
    try {
      res = await fetch(`https://login.microsoftonline.com/${encodeURIComponent(cred.tenantId)}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: cred.appId,
          client_secret: cred.secret,
          scope: 'https://api.botframework.com/.default',
        }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new ChatPlatformError('teams token: unreachable');
    }
    const json = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number; error?: string } | null;
    if (!res.ok || !json?.access_token) throw new ChatPlatformError(`teams token: ${json?.error ?? `HTTP ${res.status}`}`);
    this.tokens.set(cred.appId, { value: json.access_token, until: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000 });
    return json.access_token;
  }

  /** One Bot Connector call on the conversation's service URL. Errors carry the method and status, never the secret. */
  private async call<T = unknown>(ctx: ChatAdapterContext, chatId: string, method: string, path: string, body: unknown): Promise<T> {
    const cred = teamsCredential(ctx.token);
    if (!cred) throw new ChatPlatformError('teams: bad credential');
    const base = (this.serviceUrls.get(chatId) ?? GLOBAL_SERVICE_URL).replace(/\/$/, '');
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${await this.token(cred)}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof ChatPlatformError) throw err;
      throw new ChatPlatformError(`teams ${method}: unreachable`);
    }
    const json = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
    if (!res.ok) throw new ChatPlatformError(`teams ${method}: ${json?.error?.message ?? `HTTP ${res.status}`}`, res.status === 400);
    return (json ?? {}) as T;
  }

  private remember(map: Map<string, string>, key: string, value: string): void {
    if (map.size >= MEMORY) map.clear();
    map.set(key, value);
  }
}

/** Markdown text, then one Adaptive Card whose rows of buttons are action sets. */
function activity(msg: ChatOutMessage): Record<string, unknown> {
  const rows = msg.buttons.filter((r) => r.length);
  return {
    type: 'message',
    text: msg.text.slice(0, MAX_CHARS),
    textFormat: 'markdown',
    // Always sent, so an edit that drops the buttons clears them.
    attachments: rows.length
      ? [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              type: 'AdaptiveCard',
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              version: '1.4',
              body: rows.map((row) => ({ type: 'ActionSet', actions: row.map(cardAction) })),
            },
          },
        ]
      : [],
  };
}

function cardAction(b: ChatButton): Record<string, unknown> {
  return 'url' in b ? { type: 'Action.OpenUrl', title: b.label, url: b.url } : { type: 'Action.Submit', title: b.label, data: { a: (b as ChatActionButton).action } };
}

function isServiceUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && SERVICE_HOST_RE.test(url.hostname);
  } catch {
    return false;
  }
}

/** A team channel, the only conversation with threads; a group chat is `@thread.v2` and has none. */
const isChannel = (chatId: string): boolean => /@thread\.(tacv2|skype)$/.test(chatId);

interface TeamsActivity {
  type?: string;
  id?: string;
  timestamp?: string;
  serviceUrl?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string };
  conversation?: { id?: string; conversationType?: string; name?: string };
  replyToId?: string;
  text?: string;
  value?: unknown;
  entities?: Array<{ type?: string; text?: string; mentioned?: { id?: string } }>;
  channelData?: { channel?: { id?: string; name?: string }; team?: { id?: string } };
}
