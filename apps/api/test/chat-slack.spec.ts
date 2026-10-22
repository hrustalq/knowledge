import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlackAdapter, markdownForSlack, slackPlainText, slackSignature } from '../src/chat/adapters/slack.adapter.js';
import { ChatPlatformError, type ChatAdapterContext, type RawInbound } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * Slack (#380), the adapter on its own: the request signature, the URL
 * handshake, and recorded Events API / interactivity payloads (the shapes
 * Slack's docs give for `message`, `message_changed`, `message_deleted`,
 * `reaction_added` and `block_actions`) parsed into the core's inbound;
 * rendering to mrkdwn and blocks; threads; and the Web API calls.
 */

const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';
const BOT = 'U0BOT';
const NOW = 1_792_600_000_000;
const ctx: ChatAdapterContext = { token: 'xoxb-test', botUsername: BOT, serverUrl: null, actionUrl: '', signingSecret: SECRET };
const adapter = () => new SlackAdapter(() => NOW);

function signed(body: string, at = NOW / 1000, secret = SECRET): RawInbound {
  const ts = String(Math.floor(at));
  return { headers: { 'x-slack-request-timestamp': ts, 'x-slack-signature': slackSignature(secret, ts, body) }, body };
}
const event = (e: Record<string, unknown>) =>
  JSON.stringify({ token: 'x', team_id: 'T1', api_app_id: 'A1', type: 'event_callback', event_id: 'Ev1', event_time: 1, event: e });
const parse = (e: Record<string, unknown>, a = adapter()) => a.parseInbound({ headers: {}, body: event(e) }, BOT);

afterEach(() => vi.unstubAllGlobals());

function stubFetch(...bodies: Array<Record<string, unknown>>) {
  const fetchMock = vi.fn();
  for (const b of bodies) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(b), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const sent = (fetchMock: ReturnType<typeof vi.fn>, i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, params: Object.fromEntries(new URLSearchParams(init.body as URLSearchParams)), headers: init.headers as Record<string, string> };
};

describe('request signatures', () => {
  const body = event({ type: 'message', channel: 'C1', user: 'U1', text: 'hi', ts: '1.1' });

  it('accepts a request signed with the signing secret', () => {
    expect(adapter().verifyInbound(signed(body), null, ctx)).toBe(true);
  });

  it('refuses an unsigned, forged, stale or tampered request, and any without a secret to check against', () => {
    const a = adapter();
    expect(a.verifyInbound({ headers: {}, body }, null, ctx)).toBe(false);
    expect(a.verifyInbound(signed(body, NOW / 1000, 'not-the-secret'), null, ctx)).toBe(false);
    expect(a.verifyInbound(signed(body, NOW / 1000 - 301), null, ctx)).toBe(false);
    expect(a.verifyInbound(signed(body, NOW / 1000 + 301), null, ctx)).toBe(false);
    expect(a.verifyInbound({ ...signed(body), body: body.replace('hi', 'ho') }, null, ctx)).toBe(false);
    expect(a.verifyInbound(signed(body), null, { ...ctx, signingSecret: null })).toBe(false);
    expect(a.verifyInbound(signed(body), null, null)).toBe(false);
  });

  it('answers the Request URL check with its challenge, and nothing else as one', () => {
    const a = adapter();
    expect(a.handshake({ headers: {}, body: JSON.stringify({ token: 'x', challenge: 'c-123', type: 'url_verification' }) })).toEqual({ challenge: 'c-123' });
    expect(a.handshake({ headers: {}, body })).toBeNull();
    expect(a.parseInbound({ headers: {}, body: JSON.stringify({ type: 'url_verification', challenge: 'c' }) }, BOT)).toEqual([]);
  });
});

describe('events', () => {
  it('a mention in a channel is addressed to the bot and opens a thread on itself', () => {
    const [m] = parse({ type: 'message', channel: 'C1', channel_type: 'channel', user: 'U1', text: '<@U0BOT> how do we deploy?', ts: '1700000000.000100' });
    expect(m).toMatchObject({
      externalUserId: 'U1',
      chatId: 'C1',
      isDm: false,
      messageId: '1700000000.000100',
      text: 'how do we deploy?',
      mentioned: true,
      threadId: '1700000000.000100',
      replyToBotMessageId: null,
      command: null,
    });
    expect(m.at).toEqual(new Date(1_700_000_000_000.1));
  });

  it('a reply in a thread names its root; a channel message with no mention is not addressed', () => {
    const [m] = parse({ type: 'message', channel: 'C1', user: 'U1', text: 'and on Fridays?', ts: '1.2', thread_ts: '1.1' });
    expect(m).toMatchObject({ mentioned: false, threadId: '1.1', replyToBotMessageId: '1.1', command: null });
  });

  it('plain-word commands count when addressed: mentioned in a channel, or in a direct chat', () => {
    expect(parse({ type: 'message', channel: 'C1', user: 'U1', text: '<@U0BOT> capture', ts: '1.3', thread_ts: '1.1' })[0].command).toEqual({ name: 'capture', args: '' });
    expect(parse({ type: 'message', channel: 'C1', user: 'U1', text: 'help', ts: '1.4' })[0].command).toBeNull();
    const [dm] = parse({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'new', ts: '1.5' });
    expect(dm).toMatchObject({ isDm: true, threadId: null, command: { name: 'new', args: '' } });
  });

  it('reads Slack markup back as text', () => {
    const [m] = parse({ type: 'message', channel: 'C1', user: 'U1', text: '<@U0BOT> see <https://x.test/a?b=1&amp;c=2|the doc> in <#C9|ops> &lt;3', ts: '1.6' });
    expect(m.text).toBe('see the doc (https://x.test/a?b=1&c=2) in #ops <3');
  });

  it('drops the bot itself, other bots, and joins and topic changes', () => {
    expect(parse({ type: 'message', channel: 'C1', user: BOT, text: 'my answer', ts: '2.1' })).toEqual([]);
    expect(parse({ type: 'message', channel: 'C1', bot_id: 'B9', user: 'U9', text: 'beep', ts: '2.2' })).toEqual([]);
    expect(parse({ type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U1', text: '<@U1> has joined', ts: '2.3' })).toEqual([]);
    expect(parse({ type: 'app_mention', channel: 'C1', user: 'U1', text: '<@U0BOT> hi', ts: '2.4' })).toEqual([]);
  });

  it('an edit and a delete are changes, never questions', () => {
    const [edited] = parse({
      type: 'message',
      subtype: 'message_changed',
      channel: 'C1',
      hidden: true,
      message: { type: 'message', user: 'U1', text: 'fixed typo', ts: '3.1', edited: { user: 'U1', ts: '3.9' } },
      previous_message: { user: 'U1', text: 'fixd typo', ts: '3.1' },
      ts: '3.9',
    });
    expect(edited).toMatchObject({ change: 'edited', messageId: '3.1', text: 'fixed typo', at: new Date(3900) });
    const [deleted] = parse({ type: 'message', subtype: 'message_deleted', channel: 'C1', hidden: true, deleted_ts: '3.1', previous_message: { user: 'U1', ts: '3.1' }, ts: '4.0' });
    expect(deleted).toMatchObject({ change: 'deleted', messageId: '3.1', externalUserId: 'U1', text: '' });
  });

  it('📌 on a message asks for its thread; any other reaction is nothing', () => {
    const [r] = parse({ type: 'reaction_added', user: 'U1', reaction: 'pushpin', item_user: 'U2', item: { type: 'message', channel: 'C1', ts: '5.1' }, event_ts: '5.5' });
    expect(r).toMatchObject({ harvestReaction: true, chatId: 'C1', messageId: '5.1', externalUserId: 'U1', text: '' });
    expect(parse({ type: 'reaction_added', user: 'U1', reaction: 'thumbsup', item: { type: 'message', channel: 'C1', ts: '5.1' } })).toEqual([]);
    expect(parse({ type: 'reaction_added', user: 'U1', reaction: 'pushpin', item: { type: 'file', file: 'F1' } })).toEqual([]);
  });

  it('a retry after our own timeout is a delivery already taken', () => {
    const body = event({ type: 'message', channel: 'D1', user: 'U1', text: 'hi', ts: '6.1' });
    expect(adapter().parseInbound({ headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_timeout' }, body }, BOT)).toEqual([]);
    expect(adapter().parseInbound({ headers: { 'x-slack-retry-num': '1', 'x-slack-retry-reason': 'http_error' }, body }, BOT)).toHaveLength(1);
  });
});

describe('button presses', () => {
  const press = (actions: unknown[], responseUrl = 'https://hooks.slack.com/actions/T1/1/abc') =>
    `payload=${encodeURIComponent(
      JSON.stringify({
        type: 'block_actions',
        user: { id: 'U1', username: 'ann' },
        channel: { id: 'C1', name: 'ops' },
        container: { type: 'message', message_ts: '7.1', channel_id: 'C1' },
        message: { ts: '7.1' },
        trigger_id: 'trig-1',
        response_url: responseUrl,
        actions,
      }),
    )}`;

  it('carries the button’s value back as the action, and its note goes to the presser alone', async () => {
    const a = adapter();
    const [m] = a.parseInbound({ headers: {}, body: press([{ action_id: 'a0x0', type: 'button', value: 'v:up:1' }]) }, BOT);
    expect(m).toMatchObject({ externalUserId: 'U1', externalUserName: 'ann', chatId: 'C1', messageId: '7.1', action: { id: 'trig-1', data: 'v:up:1' } });
    const fetchMock = stubFetch({ ok: true });
    await a.acknowledge(ctx, 'trig-1', 'Thanks');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://hooks.slack.com/actions/T1/1/abc');
    expect(JSON.parse(init.body as string)).toEqual({ response_type: 'ephemeral', replace_original: false, text: 'Thanks' });
  });

  it('a link button’s click is nothing, and a response_url off Slack is never followed', async () => {
    expect(adapter().parseInbound({ headers: {}, body: press([{ action_id: 'a0x0', type: 'button', url: 'https://x' }]) }, BOT)).toEqual([]);
    const a = adapter();
    a.parseInbound({ headers: {}, body: press([{ action_id: 'a0x0', value: 'v' }], 'https://evil.test/hook') }, BOT);
    const fetchMock = stubFetch();
    await a.acknowledge(ctx, 'trig-1', 'note');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('rendering', () => {
  it('turns links, citations and emphasis into mrkdwn, and escapes everything else', () => {
    const md = '## Deploys\n**Ship** on *Tuesdays* [S1], see [runbook](/documents/d1). <!channel> & co\n```bash\nmake <x>\n```';
    expect(markdownForSlack(md, (l) => (l === 'S1' ? 'https://kb.test/documents/d9' : null), 'https://kb.test')).toBe(
      '*Deploys*\n*Ship* on _Tuesdays_ <https://kb.test/documents/d9|[1]>, see <https://kb.test/documents/d1|runbook>. &lt;!channel&gt; &amp; co\n```\nmake &lt;x&gt;\n```',
    );
  });

  it('reads plain text back the way it was written', () => {
    expect(slackPlainText('a &amp; b <https://x.test>')).toBe('a & b https://x.test');
  });

  it('posts text as sections and buttons as action rows, threaded under the question', async () => {
    const a = adapter();
    parse({ type: 'message', channel: 'C1', user: 'U1', text: '<@U0BOT> q', ts: '8.2', thread_ts: '8.1' }, a);
    const fetchMock = stubFetch({ ok: true, ts: '8.3' });
    const msg = a.render({
      kind: 'answer',
      answer: 'Yes [S1].',
      sources: [{ cite: 'S1', title: 'Deploys | ops', url: 'https://kb.test/documents/d1' }],
      sourcesHeading: 'Sources',
      full: null,
      actions: [[{ label: '👍', action: 'up' }]],
      webBaseUrl: 'https://kb.test',
    });
    expect(await a.postMessage(ctx, { chatId: 'C1', replyToMessageId: '8.2' }, msg)).toEqual({ chatId: 'C1', messageId: '8.3' });
    const { url, params, headers } = sent(fetchMock);
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(headers.authorization).toBe('Bearer xoxb-test');
    expect(params.thread_ts).toBe('8.1');
    expect(JSON.parse(params.blocks)).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: 'Yes <https://kb.test/documents/d1|[1]>.\n\n*Sources*\n1. <https://kb.test/documents/d1|Deploys ¦ ops>' } },
      { type: 'actions', elements: [{ type: 'button', action_id: 'a0x0', text: { type: 'plain_text', text: '👍', emoji: true }, value: 'up' }] },
    ]);
  });

  it('a top-level question in a direct chat is answered at the top; in a channel, in a new thread', async () => {
    const a = adapter();
    parse({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'q', ts: '9.1' }, a);
    parse({ type: 'message', channel: 'C1', user: 'U1', text: '<@U0BOT> q', ts: '9.2' }, a);
    const fetchMock = stubFetch({ ok: true, ts: '9.3' }, { ok: true, ts: '9.4' });
    const notice = a.render({ kind: 'notice', text: 'hi' });
    await a.postMessage(ctx, { chatId: 'D1', replyToMessageId: '9.1' }, notice);
    await a.postMessage(ctx, { chatId: 'C1', replyToMessageId: '9.2' }, notice);
    expect(sent(fetchMock, 0).params.thread_ts).toBeUndefined();
    expect(sent(fetchMock, 1).params.thread_ts).toBe('9.2');
  });

  it('an edit that drops the buttons clears them', async () => {
    const fetchMock = stubFetch({ ok: true });
    await adapter().editMessage(ctx, { chatId: 'C1', messageId: '9.3' }, { text: 'done', plain: 'done', buttons: [] });
    expect(sent(fetchMock).params).toMatchObject({ channel: 'C1', ts: '9.3' });
    expect(JSON.parse(sent(fetchMock).params.blocks)).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'done' } }]);
  });
});

describe('the Web API', () => {
  it('identify is auth.test, and the bot is its user id', async () => {
    stubFetch({ ok: true, url: 'https://t.slack.com/', team: 'T', user: 'kb', team_id: 'T1', user_id: 'U0BOT', bot_id: 'B1' });
    expect(await adapter().identify(ctx)).toEqual({ username: 'U0BOT' });
  });

  it('a refusal names the method and Slack’s error code, never the token', async () => {
    stubFetch({ ok: false, error: 'invalid_auth' });
    const err = await adapter().identify(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatPlatformError);
    expect((err as Error).message).toBe('slack auth.test: invalid_auth');
    stubFetch({ ok: false, error: 'invalid_blocks' });
    const formatting = await adapter().editMessage(ctx, { chatId: 'C1', messageId: '1' }, { text: 'x', plain: 'x', buttons: [] }).catch((e: unknown) => e);
    expect((formatting as ChatPlatformError).formatting).toBe(true);
  });

  it('fetchThread reads from the root, keeps people only, stops at the command, and links the root', async () => {
    const fetchMock = stubFetch(
      // Asked about a reply, Slack returns that reply alone.
      { ok: true, messages: [{ type: 'message', user: 'U2', text: 'reply', ts: '10.3', thread_ts: '10.1' }] },
      {
        ok: true,
        messages: [
          { type: 'message', user: 'U1', text: 'Should we pin node 22?', ts: '10.1', thread_ts: '10.1' },
          { type: 'message', user: 'U2', text: 'Yes, &lt;22.5 breaks', ts: '10.2', thread_ts: '10.1' },
          { type: 'message', bot_id: 'B1', user: 'U0BOT', text: 'answer', ts: '10.25', thread_ts: '10.1' },
          { type: 'message', subtype: 'channel_join', user: 'U3', text: 'joined', ts: '10.26', thread_ts: '10.1' },
          { type: 'message', user: 'U2', text: 'reply', ts: '10.3', thread_ts: '10.1' },
          { type: 'message', user: 'U1', text: '<@U0BOT> capture', ts: '10.4', thread_ts: '10.1' },
        ],
      },
      { ok: true, permalink: 'https://t.slack.com/archives/C1/p10100000' },
    );
    const thread = await adapter().fetchThread(ctx, 'C1', '10.3', '10.4', 20);
    expect(sent(fetchMock, 1).params).toMatchObject({ channel: 'C1', ts: '10.1' });
    expect(thread.messages.map((m) => [m.authorId, m.text])).toEqual([
      ['U1', 'Should we pin node 22?'],
      ['U2', 'Yes, <22.5 breaks'],
      ['U2', 'reply'],
    ]);
    expect(thread).toMatchObject({ url: 'https://t.slack.com/archives/C1/p10100000', truncated: false });
    expect(sent(fetchMock, 2).params).toEqual({ channel: 'C1', message_ts: '10.1' });
  });

  it('a thread over the cap keeps its root and the newest replies; a missing permalink is left out', async () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({ type: 'message', user: `U${i}`, text: `m${i}`, ts: `11.${i + 1}`, thread_ts: '11.1' }));
    stubFetch({ ok: true, messages }, { ok: false, error: 'missing_scope' });
    const thread = await adapter().fetchThread(ctx, 'C1', '11.1', null, 3);
    expect(thread.messages.map((m) => m.text)).toEqual(['m0', 'm3', 'm4']);
    expect(thread).toMatchObject({ url: null, truncated: true });
  });
});

describe('the webhook, for a Slack bot', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const row = { id, enabled: true, kind: 'slack', botUsername: BOT, inboundSecretHash: null };
  async function controller() {
    const { ChatWebhookController } = await import('../src/chat/chat-webhook.controller.js');
    const receive = vi.fn(async () => undefined);
    const ctl = new ChatWebhookController(
      { find: vi.fn(async () => row), context: () => ({ ...ctx, signingSecret: SECRET }) } as never,
      { get: () => new SlackAdapter() } as never,
      { receive } as never,
      { get: () => true } as never,
    );
    return { ctl, receive };
  }
  const live = (body: string) => signed(body, Date.now() / 1000);
  const req = (b: string) => ({ rawBody: Buffer.from(b) }) as never;

  it('answers a signed Request URL check with its challenge, and reads nothing else', async () => {
    const { ctl, receive } = await controller();
    const body = JSON.stringify({ token: 'x', challenge: 'c-1', type: 'url_verification' });
    await expect(ctl.receive(id, live(body).headers, req(body))).resolves.toEqual({ challenge: 'c-1' });
    expect(receive).not.toHaveBeenCalled();
  });

  it('401s an unsigned or forged request, the URL check included', async () => {
    const { UnauthorizedException } = await import('@nestjs/common');
    const { ctl, receive } = await controller();
    const body = JSON.stringify({ token: 'x', challenge: 'c-1', type: 'url_verification' });
    await expect(ctl.receive(id, {}, req(body))).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(ctl.receive(id, signed(body, Date.now() / 1000, 'forged').headers, req(body))).rejects.toBeInstanceOf(UnauthorizedException);
    expect(receive).not.toHaveBeenCalled();
  });

  it('hands a verified event on', async () => {
    const { ctl, receive } = await controller();
    const body = event({ type: 'message', channel: 'D1', channel_type: 'im', user: 'U1', text: 'hi', ts: '1.1' });
    await expect(ctl.receive(id, live(body).headers, req(body))).resolves.toEqual({ ok: true });
    expect(receive).toHaveBeenCalledWith(row, expect.objectContaining({ text: 'hi', isDm: true, chatId: 'D1' }));
  });
});
