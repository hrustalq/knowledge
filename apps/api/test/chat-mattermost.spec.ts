import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const safeFetch = vi.hoisted(() => vi.fn());
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch, guardedLookup: vi.fn() }));

import { MattermostAdapter, defuseMentions, markdownForMattermost, signAction } from '../src/chat/adapters/mattermost.adapter.js';
import { ChatAdapterRegistry } from '../src/chat/adapters/chat-adapter.registry.js';
import { ChatPlatformError, type ChatAdapterContext, type ChatInbound } from '../src/chat/adapters/chat-adapter.types.js';
import {
  ChatSocketSupervisor,
  type ChatInboxClaims,
  type ChatSocket,
} from '../src/chat/chat-socket.supervisor.js';

/**
 * The Mattermost-shaped adapter and its websocket: Time (issue #71, phase 4)
 * and Mattermost (#343), one implementation with the kind as its argument.
 *
 * Every case below runs once per kind in {@link PLATFORMS}, so the two cannot
 * drift: the fixtures are Mattermost's own shapes, which Time documents — a
 * `posted` event carries its post as a JSON string, a direct channel is
 * `channel_type: 'D'`, and a button press is the `PostActionIntegrationRequest`
 * body POSTed to the button's URL with the context it was given. The
 * Mattermost shapes were checked against a live `mattermost-preview` server
 * (#343); none is a recording from a live Time server.
 *
 * What is pinned: who is addressing the bot (mention, thread, DM), that a
 * press verifies only with the signature the bot put on it, that a press is
 * answered in its HTTP response, and that the supervisor reconnects on its
 * own and lets two replicas answer a message once.
 */

const BOT = 'knowledge';
const TOKEN = 'tok-123';
/** One entry per kind the adapter serves; the suite runs for each. */
const PLATFORMS = [
  { kind: 'time', server: 'https://time.test' },
  { kind: 'mattermost', server: 'https://mm.test' },
] as const;

/** A `posted` event as the websocket delivers it. */
function posted(
  post: Record<string, unknown>,
  data: Record<string, unknown> = {},
): { headers: Record<string, string>; body: string } {
  return {
    headers: {},
    body: JSON.stringify({
      event: 'posted',
      data: {
        channel_type: 'O',
        channel_display_name: 'Platform',
        sender_name: '@alice',
        post: JSON.stringify({ id: 'p1', user_id: 'u-alice', channel_id: 'ch-1', root_id: '', message: '', ...post }),
        ...data,
      },
      broadcast: { channel_id: 'ch-1', team_id: 't-1' },
      seq: 3,
    }),
  };
}

/** A press as Time POSTs it to the button's `integration.url`. */
function press(context: Record<string, unknown>, over: Record<string, unknown> = {}) {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      user_id: 'u-alice',
      user_name: 'alice',
      channel_id: 'ch-1',
      channel_name: 'platform',
      team_id: 't-1',
      team_domain: 'acme',
      post_id: 'bot-post',
      trigger_id: 'trig-1',
      type: '',
      data_source: '',
      context,
      ...over,
    }),
  };
}

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  safeFetch.mockReset();
});

describe.each(PLATFORMS)('$kind', ({ kind, server }) => {
  const ctx: ChatAdapterContext = {
    token: TOKEN,
    botUsername: BOT,
    serverUrl: server,
    actionUrl: 'https://kn.test/v1/chat/int-1/webhook',
  };
  const adapter = new MattermostAdapter(kind, false);

  it('is registered under its own kind', () => {
    expect(adapter.kind).toBe(kind);
    expect(adapter.inbound).toBe('socket');
  });

  describe('parseInbound — messages from the websocket', () => {
    it('a mention in a channel: addressed, mention stripped, its own thread', () => {
      const [m] = adapter.parseInbound(posted({ message: '@knowledge how do we deploy?' }), BOT);
      expect(m).toEqual({
        externalUserId: 'u-alice',
        externalUserName: '@alice',
        chatId: 'ch-1',
        chatTitle: 'Platform',
        isDm: false,
        messageId: 'p1',
        text: 'how do we deploy?',
        mentioned: true,
        replyToBotMessageId: null,
        threadId: 'p1',
        command: null,
        action: null,
      } satisfies ChatInbound);
    });

    it('a message in a thread belongs to the thread, mentioned or not', () => {
      const [m] = adapter.parseInbound(posted({ id: 'p2', root_id: 'p1', message: 'and to staging?' }), BOT);
      expect(m).toMatchObject({ mentioned: false, threadId: 'p1', replyToBotMessageId: 'p1', text: 'and to staging?' });
    });

    it('a direct message: no thread of its own, so the reply stays at the top', () => {
      const [m] = adapter.parseInbound(posted({ message: 'How do we deploy?' }, { channel_type: 'D' }), BOT);
      expect(m).toMatchObject({ isDm: true, threadId: null, mentioned: false });
    });

    it('does not take @knowledge-team or an e-mail address for a mention of @knowledge', () => {
      const [team] = adapter.parseInbound(posted({ message: 'ask @knowledge-team about it' }), BOT);
      const [mail] = adapter.parseInbound(posted({ message: 'write to bot@knowledge.test' }), BOT);
      expect(team.mentioned).toBe(false);
      expect(mail.mentioned).toBe(false);
    });

    it('reads a command as a whole word, only when addressed in a channel', () => {
      expect(adapter.parseInbound(posted({ message: '@knowledge bind' }), BOT)[0].command).toEqual({ name: 'bind', args: '' });
      expect(adapter.parseInbound(posted({ message: 'help' }, { channel_type: 'D' }), BOT)[0].command).toEqual({
        name: 'help',
        args: '',
      });
      // Said to colleagues in a channel, or part of a sentence: not a command.
      expect(adapter.parseInbound(posted({ message: 'help' }), BOT)[0].command).toBeNull();
      expect(adapter.parseInbound(posted({ message: '@knowledge help me deploy' }), BOT)[0].command).toBeNull();
    });

    it('ignores the bot itself, other bots, system messages and empty posts', () => {
      expect(adapter.parseInbound(posted({ message: 'hi' }, { sender_name: '@knowledge' }), BOT)).toEqual([]);
      expect(adapter.parseInbound(posted({ message: 'hi', props: { from_bot: 'true' } }), BOT)).toEqual([]);
      expect(adapter.parseInbound(posted({ message: 'x joined', type: 'system_join_channel' }), BOT)).toEqual([]);
      expect(adapter.parseInbound(posted({ message: '   ' }), BOT)).toEqual([]);
      expect(adapter.parseInbound({ headers: {}, body: JSON.stringify({ event: 'typing', data: {} }) }, BOT)).toEqual([]);
      expect(adapter.parseInbound({ headers: {}, body: 'not json' }, BOT)).toEqual([]);
    });
  });

  describe('button presses', () => {
    const data = 'v:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:u';

    it('verifies a press signed with the bot token, and normalises it', () => {
      const raw = press({ a: data, s: signAction(data, TOKEN) });
      expect(adapter.verifyInbound(raw, null, ctx)).toBe(true);
      expect(adapter.parseInbound(raw, BOT)).toEqual([
        {
          externalUserId: 'u-alice',
          externalUserName: '@alice',
          chatId: 'ch-1',
          chatTitle: null,
          isDm: false,
          messageId: 'bot-post',
          text: '',
          mentioned: false,
          replyToBotMessageId: null,
          threadId: null,
          command: null,
          action: { id: 'trig-1', data },
        },
      ]);
    });

    it('refuses a forged, re-targeted or unsigned context, and a message pushed at the webhook', () => {
      expect(adapter.verifyInbound(press({ a: data, s: 'forged' }), null, ctx)).toBe(false);
      // A real signature over other data: the signature is over exactly what comes back.
      expect(adapter.verifyInbound(press({ a: data.replace(':u', ':d'), s: signAction(data, TOKEN) }), null, ctx)).toBe(false);
      // Signed by another bot's token.
      expect(adapter.verifyInbound(press({ a: data, s: signAction(data, 'other') }), null, ctx)).toBe(false);
      expect(adapter.verifyInbound(press({ a: data }), null, ctx)).toBe(false);
      expect(adapter.verifyInbound(posted({ message: '@knowledge hi' }), null, ctx)).toBe(false);
      expect(adapter.verifyInbound(press({ a: data, s: signAction(data, TOKEN) }), null, null)).toBe(false);
    });

    it('a signed press is read as a press only, never as a message riding along', () => {
      const raw = press({ a: data, s: signAction(data, TOKEN) }, { event: 'posted', data: { post: '{}' } });
      expect(adapter.parseInbound(raw, BOT)).toHaveLength(1);
      expect(adapter.parseInbound(raw, BOT)[0].action).not.toBeNull();
    });

    it('knows a direct channel by its name', () => {
      const [m] = adapter.parseInbound(press({ a: data, s: 'x' }, { channel_name: 'abc123__def456' }), BOT);
      expect(m.isDm).toBe(true);
    });

    it('answers the press in the HTTP response: the note as ephemeral_text', async () => {
      const [m] = adapter.parseInbound(press({ a: data, s: signAction(data, TOKEN) }, { trigger_id: 'trig-ack' }), BOT);
      let finish!: () => void;
      const handled = new Promise<void>((r) => (finish = r));
      const response = adapter.respondToAction(m, handled);
      await adapter.acknowledge(ctx, 'trig-ack', 'Thanks for the feedback');
      await expect(response).resolves.toEqual({ ephemeral_text: 'Thanks for the feedback' });
      finish();
    });

    it('answers {} when the press is handled without a note, or never acknowledged', async () => {
      const [m] = adapter.parseInbound(press({ a: data, s: 'x' }, { trigger_id: 'trig-none' }), BOT);
      await expect(adapter.respondToAction(m, Promise.resolve())).resolves.toEqual({});
      // A late acknowledgement has nobody to answer and is not an error.
      await expect(adapter.acknowledge(ctx, 'trig-none', 'late')).resolves.toBeUndefined();
    });
  });

  describe('render', () => {
    const view = {
      kind: 'answer' as const,
      answer: 'Deploys go through [CI](/documents/d2) [S1]. Ask @channel or [x](javascript:alert(1)).',
      sources: [{ cite: 'S1', title: 'Deploy [guide]', url: 'https://kn.test/documents/d1' }],
      sourcesHeading: 'Sources',
      full: { label: 'Open the full answer', url: 'https://kn.test/assistant?thread=t' },
      actions: [[{ label: '👍', action: 'v:x:u' }]],
      webBaseUrl: 'https://kn.test',
    };

    it('keeps markdown, links the citation, resolves page links, drops unsafe ones, defuses mentions', () => {
      const out = adapter.render(view);
      expect(out.text).toContain('[CI](https://kn.test/documents/d2)');
      expect(out.text).toContain('[\\[1\\]](https://kn.test/documents/d1)');
      expect(out.text).not.toContain('javascript:');
      expect(out.text).toContain('@​channel');
      expect(out.text).toContain('**Sources**\n1. [Deploy \\[guide\\]](https://kn.test/documents/d1)');
      // Not cut, so no "open the full answer" link; the vote row stays a button.
      expect(out.buttons).toEqual(view.actions);
    });

    it('leaves code fences alone', () => {
      expect(markdownForMattermost('```\n@channel [S1]\n```', () => 'https://x', 'https://kn.test')).toBe('```\n@channel [S1]\n```');
    });

    it('defuses mentions but not addresses or URLs', () => {
      expect(defuseMentions('ping @all, mail a@b.c, see https://x.test/@user')).toBe(
        'ping @​all, mail a@b.c, see https://x.test/@user',
      );
    });
  });

  describe('API calls', () => {
    it('posts a reply into the thread of the message it answers, with signed buttons', async () => {
      safeFetch
        .mockResolvedValueOnce(json(200, { id: 'p2', root_id: 'p1' }))
        .mockResolvedValueOnce(json(201, { id: 'bot-1' }));
      const ref = await adapter.postMessage(ctx, { chatId: 'ch-1', replyToMessageId: 'p2' }, {
        text: 'Answer',
        plain: 'Answer',
        buttons: [[{ label: '👍', action: 'v:x:u' }], [{ label: 'Open', url: 'https://kn.test/a' }]],
      });
      expect(ref).toEqual({ chatId: 'ch-1', messageId: 'bot-1' });
      const [getUrl] = safeFetch.mock.calls[0];
      expect(getUrl).toBe(`${server}/api/v4/posts/p2`);
      const [url, init, allowPrivate] = safeFetch.mock.calls[1];
      expect(url).toBe(`${server}/api/v4/posts`);
      expect(allowPrivate).toBe(false);
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ channel_id: 'ch-1', root_id: 'p1', message: 'Answer\n\n[Open](https://kn.test/a)' });
      expect(body.props.attachments).toEqual([
        {
          actions: [
            {
              id: 'a0x0',
              name: '👍',
              type: 'button',
              integration: { url: ctx.actionUrl, context: { a: 'v:x:u', s: signAction('v:x:u', TOKEN) } },
            },
          ],
        },
      ]);
    });

    it('starts a thread under a top-level channel message, but not under a direct one', async () => {
      // Its own instance: which channels are direct is remembered per adapter.
      const adapter = new MattermostAdapter(kind, false);
      safeFetch.mockResolvedValueOnce(json(200, { id: 'p1', root_id: '' })).mockResolvedValueOnce(json(201, { id: 'b' }));
      await adapter.postMessage(ctx, { chatId: 'ch-1', replyToMessageId: 'p1' }, { text: 'a', plain: 'a', buttons: [] });
      expect(JSON.parse(safeFetch.mock.calls[1][1].body).root_id).toBe('p1');

      safeFetch.mockReset();
      adapter.parseInbound(posted({ id: 'd1', channel_id: 'dm-1', message: 'hi' }, { channel_type: 'D' }), BOT);
      safeFetch.mockResolvedValueOnce(json(200, { id: 'd1', root_id: '' })).mockResolvedValueOnce(json(201, { id: 'b' }));
      await adapter.postMessage(ctx, { chatId: 'dm-1', replyToMessageId: 'd1' }, { text: 'a', plain: 'a', buttons: [] });
      expect(JSON.parse(safeFetch.mock.calls[1][1].body).root_id).toBeUndefined();
    });

    it('edits with a patch that always sends the buttons, so dropping them clears them', async () => {
      safeFetch.mockResolvedValueOnce(json(200, {}));
      await adapter.editMessage(ctx, { chatId: 'ch-1', messageId: 'bot-1' }, { text: 'Done', plain: 'Done', buttons: [] });
      const [url, init] = safeFetch.mock.calls[0];
      expect(url).toBe(`${server}/api/v4/posts/bot-1/patch`);
      expect(init.method).toBe('PUT');
      expect(JSON.parse(init.body)).toEqual({ message: 'Done', props: { attachments: [] } });
    });

    it('identifies the bot by users/me and reports a refusal without the token', async () => {
      safeFetch.mockResolvedValueOnce(json(200, { id: 'b', username: 'knowledge' }));
      await expect(adapter.identify(ctx)).resolves.toEqual({ username: 'knowledge' });
      safeFetch.mockResolvedValueOnce(json(401, { message: 'Invalid or expired session' }));
      const err = await adapter.identify(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ChatPlatformError);
      expect(String(err)).toContain('Invalid or expired session');
      expect(String(err)).not.toContain(TOKEN);
      // The platform is named, so an admin with both kinds knows which server refused.
      expect(String(err)).toContain(`${kind} GET /users/me`);
    });

    it('has no webhook to register and no deep link', async () => {
      await expect(adapter.registerWebhook()).resolves.toBeUndefined();
      expect(adapter.directLink()).toBeNull();
      expect(adapter.socketUrl(`${server}/`)).toBe(`${server.replace('https:', 'wss:')}/api/v4/websocket`);
      expect(adapter.socketUrl('http://10.0.0.5:8065')).toBe('ws://10.0.0.5:8065/api/v4/websocket');
    });
  });

  // ---------------------------------------------------------------------------
  // The supervisor
  // ---------------------------------------------------------------------------

  /** A websocket the spec drives by hand. */
  class FakeSocket implements ChatSocket {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    terminated = false;
    constructor(readonly url: string, readonly token: string) {}
    on(event: string, listener: (...args: unknown[]) => void) {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
      return this;
    }
    emit(event: string, ...args: unknown[]) {
      for (const h of this.handlers.get(event) ?? []) h(...args);
    }
    ping() {}
    terminate() {
      this.terminated = true;
      this.emit('close');
    }
    removeAllListeners() {
      this.handlers.clear();
      return this;
    }
  }

  const row = {
    id: 'int-1',
    workspaceId: 'ws',
    kind,
    enabled: true,
    serverUrl: `${server}`,
    credential: 'gcm$sealed',
    botUsername: BOT,
  };

  function supervisorHarness(opts: { rows?: unknown[]; claims?: ChatInboxClaims } = {}) {
    const sockets: FakeSocket[] = [];
    const statuses: Array<string | null> = [];
    let rows = opts.rows ?? [row];
    const prisma = {
      chatIntegration: {
        findMany: vi.fn(async () => rows),
        updateMany: vi.fn(async ({ data }: { data: { webhookError: string | null } }) => {
          statuses.push(data.webhookError);
          return { count: 1 };
        }),
      },
    };
    const receive = vi.fn(async () => undefined);
    const config = {
      get: (key: string) =>
        ({ CHAT_ENABLED: true, CHAT_SOCKET_SYNC_MS: 15_000, CHAT_ALLOW_PRIVATE_URLS: false, REDIS_URL: 'redis://x' })[key],
    };
    const claims = opts.claims ?? { claim: vi.fn(async () => true) };
    const sup = new ChatSocketSupervisor(
      prisma as never,
      { socket: () => adapter } as never,
      { context: () => ({ ...ctx }) } as never,
      { receive } as never,
      config as never,
      (url, token) => {
        const s = new FakeSocket(url, token);
        sockets.push(s);
        return s;
      },
      claims,
    );
    return { sup, sockets, statuses, receive, prisma, setRows: (r: unknown[]) => (rows = r) };
  }

  const flush = () => new Promise((r) => setImmediate(r));

  describe('ChatSocketSupervisor', () => {
    beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] }));
    afterEach(() => vi.useRealTimers());

    it('opens one authenticated socket per enabled bot and clears the status on hello', async () => {
      const h = supervisorHarness();
      await h.sup.sync();
      expect(h.sockets).toHaveLength(1);
      expect(h.sockets[0].url).toBe(`${server.replace('https:', 'wss:')}/api/v4/websocket`);
      expect(h.sockets[0].token).toBe(TOKEN);
      h.sockets[0].emit('open');
      h.sockets[0].emit('message', JSON.stringify({ event: 'hello', data: { server_version: '3.6' }, seq: 0 }));
      await flush();
      expect(h.statuses).toEqual([null]);
      expect(h.sup.connectedIds()).toEqual(['int-1']);
      h.sup.onModuleDestroy();
    });

    it('hands a posted message to the answer path', async () => {
      const h = supervisorHarness();
      await h.sup.sync();
      h.sockets[0].emit('message', posted({ message: '@knowledge how do we deploy?' }).body);
      await flush();
      expect(h.receive).toHaveBeenCalledOnce();
      expect(h.receive).toHaveBeenCalledWith(row, expect.objectContaining({ text: 'how do we deploy?', mentioned: true }));
      h.sup.onModuleDestroy();
    });

    it('two replicas holding the same bot hand a message on once', async () => {
      const taken = new Set<string>();
      const shared: ChatInboxClaims = { claim: async (key) => !taken.has(key) && !!taken.add(key) };
      const a = supervisorHarness({ claims: shared });
      const b = supervisorHarness({ claims: shared });
      await a.sup.sync();
      await b.sup.sync();
      const frame = posted({ message: '@knowledge hi' }).body;
      a.sockets[0].emit('message', frame);
      b.sockets[0].emit('message', frame);
      await flush();
      expect(a.receive.mock.calls.length + b.receive.mock.calls.length).toBe(1);
      a.sup.onModuleDestroy();
      b.sup.onModuleDestroy();
    });

    it('still answers when the claim store is down — the answer row is the backstop', async () => {
      const h = supervisorHarness({ claims: { claim: async () => Promise.reject(new Error('redis down')) } });
      await h.sup.sync();
      h.sockets[0].emit('message', posted({ message: '@knowledge hi' }).body);
      await flush();
      expect(h.receive).toHaveBeenCalledOnce();
      h.sup.onModuleDestroy();
    });

    it('reconnects on its own with backoff, and says why it is deaf meanwhile', async () => {
      const h = supervisorHarness();
      await h.sup.sync();
      h.sockets[0].emit('unexpected-response', {}, { statusCode: 401 });
      await flush();
      expect(h.statuses.at(-1)).toMatch(/HTTP 401 \(token refused\)/);
      expect(h.sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
      // The second drop waits longer.
      h.sockets[1].emit('close');
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets).toHaveLength(3);
      h.sockets[2].emit('message', JSON.stringify({ event: 'hello' }));
      await flush();
      expect(h.statuses.at(-1)).toBeNull();
      h.sup.onModuleDestroy();
    });

    it('terminates a socket that has gone silent, and reconnects', async () => {
      const h = supervisorHarness();
      await h.sup.sync();
      h.sockets[0].emit('open');
      await vi.advanceTimersByTimeAsync(90_000);
      expect(h.sockets[0].terminated).toBe(true);
      expect(h.statuses.at(-1)).toMatch(/no answer from the server/);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(h.sockets.length).toBeGreaterThan(1);
      h.sup.onModuleDestroy();
    });

    it('closes a bot switched off, and reopens one given a new token', async () => {
      const h = supervisorHarness();
      await h.sup.sync();
      h.setRows([{ ...row, credential: 'gcm$new' }]);
      await h.sup.sync();
      expect(h.sockets[0].terminated).toBe(true);
      expect(h.sockets).toHaveLength(2);
      h.setRows([]);
      await h.sup.sync();
      expect(h.sockets[1].terminated).toBe(true);
      // Closed on purpose: no reconnect follows.
      await vi.advanceTimersByTimeAsync(120_000);
      expect(h.sockets).toHaveLength(2);
    });
  });

  describe('capture and fetchThread (#82)', () => {
    it('capture, remember and запомни are one command, and only when addressed in a channel', () => {
      for (const word of ['capture', 'Remember', 'запомни']) {
        const [m] = adapter.parseInbound(posted({ message: `@knowledge ${word}`, root_id: 'root-1' }), BOT);
        expect(m!.command).toEqual({ name: 'capture', args: '' });
      }
      const [plain] = adapter.parseInbound(posted({ message: 'capture', root_id: 'root-1' }), BOT);
      expect(plain!.command).toBeNull();
    });

    it("reads people's messages before the command, root first, with a team permalink", async () => {
      const post = (id: string, at: number, extra: Record<string, unknown> = {}) => ({
        id,
        user_id: 'u-alice',
        message: `message ${id}`,
        create_at: at,
        ...extra,
      });
      safeFetch
        .mockResolvedValueOnce(
          json(200, {
            order: [],
            posts: {
              r: post('r', 1),
              b: post('b', 3, { props: { from_bot: 'true' } }),
              j: post('j', 4, { type: 'system_join_channel' }),
              a: post('a', 2, { user_id: 'u-bob' }),
              cmd: post('cmd', 5),
              late: post('late', 6),
            },
          }),
        )
        .mockResolvedValueOnce(json(200, { team_id: 't-1' }))
        .mockResolvedValueOnce(json(200, { name: 'platform' }));
      const thread = await adapter.fetchThread(ctx, 'ch-1', 'r', 'cmd', 200);
      expect(thread.messages.map((m) => [m.authorId, m.text])).toEqual([
        ['u-alice', 'message r'],
        ['u-bob', 'message a'],
      ]);
      expect(thread.url).toBe(`${server}/platform/pl/r`);
      expect(thread.truncated).toBe(false);
      expect(safeFetch.mock.calls[0][0]).toBe(`${server}/api/v4/posts/r/thread`);
    });

    it('keeps the root and the newest replies past the cap; no link in a direct channel', async () => {
      const posts = Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [`p${i}`, { id: `p${i}`, user_id: 'u', message: `m${i}`, create_at: i }]),
      );
      safeFetch.mockResolvedValueOnce(json(200, { posts })).mockResolvedValueOnce(json(200, { team_id: '' }));
      const thread = await adapter.fetchThread(ctx, 'dm-1', 'p0', 'none', 3);
      expect(thread.messages.map((m) => m.text)).toEqual(['m0', 'm4', 'm5']);
      expect(thread.truncated).toBe(true);
      expect(thread.url).toBeNull();
    });
  });

  /** A `reaction_added` event as the websocket delivers it: the Reaction as a JSON string. */
  function reacted(reaction: Record<string, unknown>): string {
    return JSON.stringify({
      event: 'reaction_added',
      data: {
        reaction: JSON.stringify({ user_id: 'u-alice', post_id: 'p-3', emoji_name: 'pushpin', create_at: 1_760_000_000_000, channel_id: 'ch-7', ...reaction }),
      },
      // A channel of its own: the shared adapter remembers earlier tests' direct ones.
      broadcast: { channel_id: 'ch-7' },
      seq: 4,
    });
  }

  describe('📌 reactions (#82, phase 4)', () => {
    it('📌 is a harvest request on the post; any other emoji is nothing', () => {
      const [m] = adapter.parseInbound({ headers: {}, body: reacted({}) }, BOT);
      expect(m).toMatchObject({
        externalUserId: 'u-alice',
        chatId: 'ch-7',
        isDm: false,
        messageId: 'p-3',
        text: '',
        command: null,
        harvestReaction: true,
        at: new Date(1_760_000_000_000),
      });
      for (const emoji_name of ['white_check_mark', 'pushpin_2', '']) {
        expect(adapter.parseInbound({ headers: {}, body: reacted({ emoji_name }) }, BOT)).toEqual([]);
      }
    });

    it('reads the whole thread from a reply, linking the root', async () => {
      safeFetch
        .mockResolvedValueOnce(
          json(200, {
            posts: {
              r: { id: 'r', user_id: 'u-alice', message: 'root', create_at: 1 },
              x: { id: 'x', user_id: 'u-bob', root_id: 'r', message: 'reply', create_at: 2 },
              y: { id: 'y', user_id: 'u-alice', root_id: 'r', message: 'later', create_at: 3 },
            },
          }),
        )
        .mockResolvedValueOnce(json(200, { team_id: 't-1' }))
        .mockResolvedValueOnce(json(200, { name: 'platform' }));
      const thread = await adapter.fetchThread(ctx, 'ch-1', 'x', null, 200);
      expect(thread.messages.map((m) => m.text)).toEqual(['root', 'reply', 'later']);
      expect(thread.url).toBe(`${server}/platform/pl/r`);
      expect(safeFetch.mock.calls[0][0]).toBe(`${server}/api/v4/posts/x/thread`);
    });

    it('the supervisor hands a pin on once per person, apart from the post itself', async () => {
      const taken = new Set<string>();
      const shared: ChatInboxClaims = { claim: async (key) => !taken.has(key) && !!taken.add(key) };
      const h = supervisorHarness({ claims: shared });
      await h.sup.sync();
      h.sockets[0].emit('message', posted({ id: 'p-3', message: '@knowledge hi' }).body);
      h.sockets[0].emit('message', reacted({}));
      h.sockets[0].emit('message', reacted({}));
      h.sockets[0].emit('message', reacted({ user_id: 'u-bob' }));
      await flush();
      expect(h.receive).toHaveBeenCalledTimes(3);
      expect(h.receive).toHaveBeenCalledWith(row, expect.objectContaining({ messageId: 'p-3', harvestReaction: true, externalUserId: 'u-bob' }));
      h.sup.onModuleDestroy();
    });
  });
});

describe('one supervisor, both kinds (#343)', () => {
  it('asks for every socket kind, dials each bot at its own server and parses with its own adapter', async () => {
    const rows = PLATFORMS.map((p, i) => ({
      id: `int-${p.kind}`,
      workspaceId: 'ws',
      kind: p.kind,
      enabled: true,
      serverUrl: p.server,
      credential: `gcm$${i}`,
      botUsername: BOT,
    }));
    const findMany = vi.fn(async () => rows);
    const env: Record<string, unknown> = {
      CHAT_ENABLED: true,
      CHAT_SOCKET_SYNC_MS: 15_000,
      CHAT_ALLOW_PRIVATE_URLS: false,
      REDIS_URL: 'redis://x',
      TELEGRAM_API_BASE_URL: 'https://api.telegram.org',
    };
    const config = { get: (key: string) => env[key] };
    const listeners = new Map<string, (data: unknown) => void>();
    const receive = vi.fn(async () => undefined);
    const sup = new ChatSocketSupervisor(
      { chatIntegration: { findMany, updateMany: vi.fn(async () => ({ count: 1 })) } } as never,
      new ChatAdapterRegistry(config as never),
      { context: (r: { serverUrl: string }) => ({ token: TOKEN, botUsername: BOT, serverUrl: r.serverUrl, actionUrl: '' }) } as never,
      { receive } as never,
      config as never,
      (url) => {
        const socket = {
          on: (event: string, listener: (data: unknown) => void) => {
            if (event === 'message') listeners.set(url, listener);
            return socket;
          },
          ping: () => undefined,
          terminate: () => undefined,
          removeAllListeners: () => socket,
        };
        return socket as unknown as ChatSocket;
      },
      { claim: async () => true },
    );
    await sup.sync();
    expect(findMany).toHaveBeenCalledWith({ where: { kind: { in: ['time', 'mattermost'] }, enabled: true } });
    expect([...listeners.keys()].sort()).toEqual(['wss://mm.test/api/v4/websocket', 'wss://time.test/api/v4/websocket']);
    listeners.get('wss://mm.test/api/v4/websocket')!(posted({ message: '@knowledge hi' }).body);
    await new Promise((r) => setImmediate(r));
    expect(receive).toHaveBeenCalledWith(rows[1], expect.objectContaining({ text: 'hi', mentioned: true }));
    sup.onModuleDestroy();
  });
});
