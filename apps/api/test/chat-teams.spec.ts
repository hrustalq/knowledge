import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { TeamsAdapter, splitConversation, teamsCredential, teamsText } from '../src/chat/adapters/teams.adapter.js';
import type { ChatAdapterContext, RawInbound } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * Microsoft Teams (#381), the adapter on its own: Bot Framework JWT validation
 * against a local key set standing in for login.botframework.com, and
 * activities in the shapes Bot Framework documents for Teams (a channel
 * mention, a thread reply, a personal chat, an Adaptive Card submit, edits and
 * deletes); then the token exchange, threads, cards and links.
 */

const APP = '11111111-2222-4333-8444-555555555555';
const TENANT = '99999999-8888-4777-8666-555555555555';
const SERVICE = 'https://smba.trafficmanager.net/emea/';
const CHANNEL = '19:abc123@thread.tacv2';
const ctx: ChatAdapterContext = { token: `${APP}:${TENANT}:s3cr~et.value`, botUsername: APP, serverUrl: null, actionUrl: '' };

let privateKey: KeyLike;
let jwks: ReturnType<typeof createLocalJWKSet>;
let otherKey: KeyLike;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk: JWK = { ...(await exportJWK(pair.publicKey)), kid: 'bf-1', alg: 'RS256', use: 'sig' };
  jwks = createLocalJWKSet({ keys: [jwk] });
  otherKey = (await generateKeyPair('RS256')).privateKey;
});

afterEach(() => vi.unstubAllGlobals());

const jwt = (claims: Record<string, unknown> = {}, opts: { key?: KeyLike; iss?: string; aud?: string; exp?: string } = {}) =>
  new SignJWT({ serviceurl: SERVICE, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'bf-1' })
    .setIssuer(opts.iss ?? 'https://api.botframework.com')
    .setAudience(opts.aud ?? APP)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(opts.key ?? privateKey);

function activity(over: Record<string, unknown> = {}) {
  return {
    type: 'message',
    id: '1700000000001',
    timestamp: '2026-10-22T10:00:00.000Z',
    serviceUrl: SERVICE,
    channelId: 'msteams',
    from: { id: '29:user-ann', name: 'Ann', aadObjectId: 'aad-ann' },
    recipient: { id: `28:${APP}`, name: 'Knowledge' },
    conversation: { id: CHANNEL, conversationType: 'channel' },
    text: '<at>Knowledge</at> how do we deploy?',
    entities: [{ type: 'mention', text: '<at>Knowledge</at>', mentioned: { id: `28:${APP}`, name: 'Knowledge' } }],
    channelData: { channel: { id: CHANNEL, name: 'ops' }, team: { id: 'team-1' } },
    ...over,
  };
}
const raw = (a: unknown, headers: Record<string, string> = {}): RawInbound => ({ headers, body: JSON.stringify(a) });
const parse = (a: unknown, adapter = new TeamsAdapter(jwks)) => adapter.parseInbound(raw(a), APP);

describe('inbound authentication', () => {
  const check = async (token: string | null, a = activity(), c: ChatAdapterContext | null = ctx) =>
    new TeamsAdapter(jwks).verifyInbound(raw(a, token ? { authorization: `Bearer ${token}` } : {}), null, c);

  it('accepts a Bot Framework token for this app, from the service the activity names', async () => {
    expect(await check(await jwt())).toBe(true);
  });

  it('refuses no token, a forged signature, another issuer, another app, an expired token, or a service URL the token does not name', async () => {
    expect(await check(null)).toBe(false);
    expect(await check(await jwt({}, { key: otherKey }))).toBe(false);
    expect(await check(await jwt({}, { iss: 'https://sts.windows.net/x/' }))).toBe(false);
    expect(await check(await jwt({}, { aud: 'another-app' }))).toBe(false);
    expect(await check(await jwt({}, { exp: '-10m' }))).toBe(false);
    expect(await check(await jwt(), activity({ serviceUrl: 'https://evil.example/' }))).toBe(false);
    expect(await check(await jwt(), activity(), null)).toBe(false);
  });
});

describe('activities', () => {
  it('a channel mention is addressed, its own thread and topic, with the mention removed', () => {
    const [m] = parse(activity());
    expect(m).toMatchObject({
      externalUserId: 'aad-ann',
      externalUserName: 'Ann',
      chatId: CHANNEL,
      chatTitle: 'ops',
      isDm: false,
      messageId: '1700000000001',
      text: 'how do we deploy?',
      mentioned: true,
      threadId: '1700000000001',
      topicId: '1700000000001',
      replyToBotMessageId: null,
      command: null,
    });
    expect(m.replyTo).toBeUndefined();
  });

  it('a thread reply names its root as thread, topic and the message capture reads from', () => {
    const [m] = parse(activity({ id: '1700000000009', conversation: { id: `${CHANNEL};messageid=1700000000001`, conversationType: 'channel' }, text: '<at>Knowledge</at> capture' }));
    expect(m).toMatchObject({
      chatId: CHANNEL,
      threadId: '1700000000001',
      topicId: '1700000000001',
      replyToBotMessageId: '1700000000001',
      command: { name: 'capture', args: '' },
      replyTo: { messageId: '1700000000001', text: '', fromBot: false },
    });
  });

  it('a channel message nobody addressed to the bot is heard but not a command', () => {
    const [m] = parse(activity({ text: 'help', entities: [] }));
    expect(m).toMatchObject({ mentioned: false, command: null, text: 'help', topicId: '1700000000001' });
  });

  it('a personal chat has no thread; a group chat has none either', () => {
    const [dm] = parse(activity({ conversation: { id: 'a:1dm', conversationType: 'personal' }, text: 'new', entities: [], channelData: {} }));
    expect(dm).toMatchObject({ isDm: true, threadId: null, topicId: null, command: { name: 'new', args: '' } });
    const [group] = parse(activity({ conversation: { id: '19:chat@thread.v2', conversationType: 'groupChat' }, channelData: {} }));
    expect(group).toMatchObject({ isDm: false, threadId: null, topicId: null, mentioned: true });
  });

  it('an Adaptive Card submit is a press on the bot’s message, carrying the button’s data', () => {
    const [m] = parse(activity({ id: 'press-1', text: undefined, value: { a: 'v:up:42' }, replyToId: 'bot-msg-7', entities: [] }));
    expect(m).toMatchObject({ messageId: 'bot-msg-7', action: { id: 'press-1', data: 'v:up:42' }, text: '' });
  });

  it('edits and deletes are changes; the bot’s own messages and other activities are nothing', () => {
    expect(parse(activity({ type: 'messageUpdate', text: 'fixed', entities: [] }))[0]).toMatchObject({ change: 'edited', text: 'fixed' });
    expect(parse(activity({ type: 'messageDelete', text: undefined }))[0]).toMatchObject({ change: 'deleted', messageId: '1700000000001' });
    expect(parse(activity({ from: { id: `28:${APP}` } }))).toEqual([]);
    expect(parse(activity({ type: 'conversationUpdate' }))).toEqual([]);
    expect(parse(activity({ type: 'messageReaction', text: undefined }))).toEqual([]);
  });

  it('reads Teams HTML back as text', () => {
    expect(teamsText('<at>Knowledge</at> <p>Use&nbsp;<b>v22</b> &amp; pin it</p>', ['<at>Knowledge</at>'])).toBe('Use v22 & pin it');
    expect(splitConversation(`${CHANNEL};messageid=42`)).toEqual({ chatId: CHANNEL, root: '42' });
    expect(teamsCredential('app:tenant:se:cret')).toEqual({ appId: 'app', tenantId: 'tenant', secret: 'se:cret' });
    expect(teamsCredential('just-a-token')).toBeNull();
  });
});

describe('outbound', () => {
  function stubFetch(...responses: Array<{ status?: number; body: unknown }>) {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status ?? 200 }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }
  const sent = (fetchMock: ReturnType<typeof vi.fn>, i: number) => {
    const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
    return { url, init, body: typeof init.body === 'string' ? JSON.parse(init.body) : Object.fromEntries(new URLSearchParams(init.body as URLSearchParams)) };
  };

  it('identify proves the credential with a single-tenant token for Bot Framework; the bot is its app id', async () => {
    const fetchMock = stubFetch({ body: { access_token: 'tok', expires_in: 3600 } });
    expect(await new TeamsAdapter(jwks).identify(ctx)).toEqual({ username: APP });
    const { url, body } = sent(fetchMock, 0);
    expect(url).toBe(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
    expect(body).toEqual({ grant_type: 'client_credentials', client_id: APP, client_secret: 's3cr~et.value', scope: 'https://api.botframework.com/.default' });
  });

  it('a refused credential names Microsoft’s error, never the secret', async () => {
    stubFetch({ status: 401, body: { error: 'invalid_client' } });
    await expect(new TeamsAdapter(jwks).identify(ctx)).rejects.toThrow('teams token: invalid_client');
  });

  it('answers in the question’s thread on its service URL, with buttons as an Adaptive Card, then edits there', async () => {
    const a = new TeamsAdapter(jwks);
    parse(activity(), a);
    const fetchMock = stubFetch({ body: { access_token: 'tok', expires_in: 3600 } }, { body: { id: 'bot-1' } }, { body: {} });
    const msg = a.render({
      kind: 'answer',
      answer: 'Ship on Tuesdays [S1].',
      sources: [{ cite: 'S1', title: 'Deploys', url: 'https://kb.test/documents/d1' }],
      sourcesHeading: 'Sources',
      full: null,
      actions: [[{ label: '👍', action: 'up' }]],
      webBaseUrl: 'https://kb.test',
    });
    expect(await a.postMessage(ctx, { chatId: CHANNEL, replyToMessageId: '1700000000001' }, msg)).toEqual({ chatId: CHANNEL, messageId: 'bot-1' });
    const post = sent(fetchMock, 1);
    expect(post.url).toBe(`https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=1700000000001`)}/activities`);
    expect((post.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(post.body).toMatchObject({ type: 'message', textFormat: 'markdown' });
    expect(post.body.text).toContain('[\\[1\\]](https://kb.test/documents/d1)');
    expect(post.body.attachments[0].content.body).toEqual([{ type: 'ActionSet', actions: [{ type: 'Action.Submit', title: '👍', data: { a: 'up' } }] }]);

    await a.editMessage(ctx, { chatId: CHANNEL, messageId: 'bot-1' }, { text: 'done', plain: 'done', buttons: [] });
    const edit = sent(fetchMock, 2);
    expect(edit.init.method).toBe('PUT');
    expect(edit.url).toBe(`https://smba.trafficmanager.net/emea/v3/conversations/${encodeURIComponent(`${CHANNEL};messageid=1700000000001`)}/activities/bot-1`);
    expect(edit.body.attachments).toEqual([]);
  });

  it('a personal chat is answered in the chat itself; an unknown conversation uses the global service URL', async () => {
    const fetchMock = stubFetch({ body: { access_token: 'tok', expires_in: 3600 } }, { body: { id: 'bot-2' } });
    await new TeamsAdapter(jwks).postMessage(ctx, { chatId: 'a:1dm', replyToMessageId: 'm-1' }, { text: 'hi', plain: 'hi', buttons: [] });
    expect(sent(fetchMock, 1).url).toBe(`https://smba.trafficmanager.net/teams/v3/conversations/${encodeURIComponent('a:1dm')}/activities`);
  });

  it('a service URL off Bot Framework’s hosts is never remembered', async () => {
    const a = new TeamsAdapter(jwks);
    parse(activity({ serviceUrl: 'https://evil.example/' }), a);
    const fetchMock = stubFetch({ body: { access_token: 'tok', expires_in: 3600 } }, { body: { id: 'bot-3' } });
    await a.postMessage(ctx, { chatId: CHANNEL }, { text: 'x', plain: 'x', buttons: [] });
    expect(sent(fetchMock, 1).url.startsWith('https://smba.trafficmanager.net/teams/')).toBe(true);
  });

  it('links: a channel message opens in Teams, a chat has none; the bot opens by its app id', () => {
    const a = new TeamsAdapter(jwks);
    expect(a.messageUrl(CHANNEL, '42')).toBe(`https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/42`);
    expect(a.messageUrl('19:chat@thread.v2', '42')).toBeNull();
    expect(a.directLink(APP)).toBe(`https://teams.microsoft.com/l/chat/0/0?users=28:${APP}`);
  });
});
