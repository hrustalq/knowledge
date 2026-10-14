import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  TelegramAdapter,
  cutAnswer,
  hashInboundSecret,
  markdownToTelegramHtml,
} from '../src/chat/adapters/telegram.adapter.js';
import { ChatPlatformError } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * The Telegram adapter (issue #71, phase 1): the secret check that guards the
 * public webhook, the normalisation every later decision reads, and the HTML
 * that must never let page text inject markup.
 */

const adapter = new TelegramAdapter('https://api.telegram.test');
const BOT = 'kn_bot';

function update(message: Record<string, unknown>): { headers: Record<string, string>; body: string } {
  return { headers: {}, body: JSON.stringify({ update_id: 1, message }) };
}

const from = { id: 42, is_bot: false, username: 'alice', first_name: 'Alice' };
const dm = { id: 42, type: 'private' };
const group = { id: -1001, type: 'supergroup', title: 'Platform team' };

function press(callback: Record<string, unknown>): { headers: Record<string, string>; body: string } {
  return { headers: {}, body: JSON.stringify({ update_id: 2, callback_query: callback }) };
}

describe('verifyInbound', () => {
  const hash = hashInboundSecret('s3cret');

  it('accepts the secret the webhook was registered with', () => {
    expect(adapter.verifyInbound({ headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: '' }, hash)).toBe(true);
  });

  it('refuses a wrong, missing or unregistered secret', () => {
    expect(adapter.verifyInbound({ headers: { 'x-telegram-bot-api-secret-token': 'nope' }, body: '' }, hash)).toBe(false);
    expect(adapter.verifyInbound({ headers: {}, body: '' }, hash)).toBe(false);
    expect(adapter.verifyInbound({ headers: { 'x-telegram-bot-api-secret-token': 's3cret' }, body: '' }, null)).toBe(false);
  });
});

describe('parseInbound — button presses', () => {
  it('normalises a press: the message is the bot’s, the data comes back as sent', () => {
    const [m] = adapter.parseInbound(
      press({ id: 'cb-1', from, data: 'v:abc:u', message: { message_id: 99, chat: group } }),
      BOT,
    );
    expect(m).toEqual({
      externalUserId: '42',
      externalUserName: '@alice',
      chatId: '-1001',
      chatTitle: 'Platform team',
      isDm: false,
      messageId: '99',
      text: '',
      mentioned: false,
      replyToBotMessageId: null,
      threadId: null,
      command: null,
      action: { id: 'cb-1', data: 'v:abc:u' },
    });
  });

  it('drops a press with no data, no message (too old) or from a bot', () => {
    expect(adapter.parseInbound(press({ id: 'cb', from, message: { message_id: 1, chat: dm } }), BOT)).toEqual([]);
    expect(adapter.parseInbound(press({ id: 'cb', from, data: 'x' }), BOT)).toEqual([]);
    expect(
      adapter.parseInbound(press({ id: 'cb', from: { ...from, is_bot: true }, data: 'x', message: { message_id: 1, chat: dm } }), BOT),
    ).toEqual([]);
  });
});

describe('parseInbound', () => {
  it('normalises a private message', () => {
    const [m] = adapter.parseInbound(update({ message_id: 7, from, chat: dm, text: 'How do we deploy?' }), BOT);
    expect(m).toEqual({
      externalUserId: '42',
      externalUserName: '@alice',
      chatId: '42',
      chatTitle: null,
      isDm: true,
      messageId: '7',
      text: 'How do we deploy?',
      mentioned: false,
      replyToBotMessageId: null,
      threadId: null,
      command: null,
      action: null,
    });
  });

  it('strips the bot mention in a group and marks it addressed', () => {
    const [m] = adapter.parseInbound(update({ message_id: 8, from, chat: group, text: '@KN_bot how do we deploy?' }), BOT);
    expect(m).toMatchObject({ isDm: false, chatTitle: 'Platform team', mentioned: true, text: 'how do we deploy?' });
  });

  it('treats a reply to the bot as addressed and remembers which message', () => {
    const [m] = adapter.parseInbound(
      update({
        message_id: 9,
        from,
        chat: group,
        text: 'and on staging?',
        reply_to_message: { message_id: 5, from: { id: 1, is_bot: true, username: 'kn_bot' } },
      }),
      BOT,
    );
    expect(m).toMatchObject({ mentioned: true, replyToBotMessageId: '5' });
  });

  it('parses commands, and drops one addressed to another bot', () => {
    const [own] = adapter.parseInbound(update({ message_id: 1, from, chat: group, text: '/ask@kn_bot what is X' }), BOT);
    expect(own.command).toEqual({ name: 'ask', args: 'what is X' });
    expect(adapter.parseInbound(update({ message_id: 2, from, chat: group, text: '/help@other_bot' }), BOT)).toEqual([]);
  });

  it('drops bots, edits, empty messages and garbage', () => {
    expect(adapter.parseInbound(update({ message_id: 1, from: { ...from, is_bot: true }, chat: dm, text: 'hi' }), BOT)).toEqual([]);
    expect(adapter.parseInbound({ headers: {}, body: JSON.stringify({ edited_message: { text: 'x' } }) }, BOT)).toEqual([]);
    expect(adapter.parseInbound(update({ message_id: 1, from, chat: dm }), BOT)).toEqual([]);
    expect(adapter.parseInbound({ headers: {}, body: 'not json' }, BOT)).toEqual([]);
  });
});

describe('markdownToTelegramHtml', () => {
  const cite = (label: string) => (label === 'S1' ? 'https://kn.test/documents/d1' : null);

  it('escapes everything before adding tags, so page text cannot inject markup', () => {
    const html = markdownToTelegramHtml('Use <script>alert(1)</script> & **bold**', cite, 'https://kn.test');
    expect(html).toBe('Use &lt;script&gt;alert(1)&lt;/script&gt; &amp; <b>bold</b>');
  });

  it('turns citation markers into numbered links, and keeps unknown labels as numbers', () => {
    expect(markdownToTelegramHtml('Deploys go through CI [S1, S2].', cite, 'https://kn.test')).toBe(
      'Deploys go through CI <a href="https://kn.test/documents/d1">[1]</a>[2].',
    );
  });

  it('resolves relative page links against the web app and drops unsafe schemes', () => {
    expect(markdownToTelegramHtml('[Runbook](/documents/d9) and [x](javascript:alert(1))', cite, 'https://kn.test')).toBe(
      '<a href="https://kn.test/documents/d9">Runbook</a> and x',
    );
  });

  it('renders headings, bullets, inline code and fenced code', () => {
    const html = markdownToTelegramHtml('## Steps\n- run `make <x>`\n```\na < b\n```', cite, 'https://kn.test');
    expect(html).toBe('<b>Steps</b>\n• run <code>make &lt;x&gt;</code>\n<pre>a &lt; b</pre>');
  });
});

describe('render', () => {
  const view = {
    kind: 'answer' as const,
    answer: 'Deploys go through CI [S1].',
    sources: [{ cite: 'S1', title: 'Deploy <guide>', url: 'https://kn.test/documents/d1' }],
    sourcesHeading: 'Sources',
    full: { label: 'Open the full answer', url: 'https://kn.test/assistant?thread=t1' },
    actions: [] as Array<Array<{ label: string; action: string }>>,
    webBaseUrl: 'https://kn.test',
  };

  it('lists the sources under the answer and offers no button when nothing was cut', () => {
    const out = adapter.render(view);
    expect(out.text).toContain('<b>Sources</b>\n[1] <a href="https://kn.test/documents/d1">Deploy &lt;guide&gt;</a>');
    expect(out.plain).toContain('[1] Deploy <guide> — https://kn.test/documents/d1');
    expect(out.buttons).toEqual([]);
  });

  it('cuts an answer over the limit and links the whole one', () => {
    const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} is here.`).join(' ');
    const out = adapter.render({ ...view, answer: long });
    expect(out.plain.length).toBeLessThanOrEqual(adapter.limits.maxChars);
    expect(out.text).toContain('…');
    expect(out.buttons).toEqual([[view.full]]);
  });

  it('puts the action rows under the answer, after the full-answer link', () => {
    const vote = [[{ label: '👍', action: 'v:a:u' }, { label: '👎', action: 'v:a:d' }]];
    expect(adapter.render({ ...view, actions: vote }).buttons).toEqual(vote);
    const long = Array.from({ length: 400 }, (_, i) => `Sentence ${i} is here.`).join(' ');
    expect(adapter.render({ ...view, answer: long, actions: vote }).buttons).toEqual([[view.full], ...vote]);
  });

  it('a notice is escaped text with its button', () => {
    const out = adapter.render({ kind: 'notice', text: 'a <b>', button: { label: 'Go', url: 'https://x.test' } });
    expect(out).toEqual({ text: 'a &lt;b&gt;', plain: 'a <b>', buttons: [[{ label: 'Go', url: 'https://x.test' }]] });
  });
});

describe('cutAnswer', () => {
  it('closes a code fence it cut through', () => {
    const { text, cut } = cutAnswer('intro\n\n```\n' + 'x\n'.repeat(100) + '```', 60);
    expect(cut).toBe(true);
    expect((text.match(/```/g) ?? []).length % 2).toBe(0);
  });
});

describe('Bot API calls', () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(...responses: Array<{ status: number; body: unknown }>) {
    const fetchMock = vi.fn();
    for (const r of responses) fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(r.body), { status: r.status }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('falls back to plain text when Telegram refuses the HTML', async () => {
    const fetchMock = stubFetch(
      { status: 400, body: { ok: false, description: "Bad Request: can't parse entities" } },
      { status: 200, body: { ok: true, result: { message_id: 99 } } },
    );
    const ref = await adapter.postMessage(
      { token: 'T0KEN', botUsername: BOT, serverUrl: null, actionUrl: '' },
      { chatId: '42' },
      { text: '<b>x', plain: 'x', buttons: [[{ label: 'Open', url: 'http://localhost:5173/a' }]] },
    );
    expect(ref).toEqual({ chatId: '42', messageId: '99' });
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as Record<string, unknown>;
    expect(second).not.toHaveProperty('parse_mode');
    expect(second).not.toHaveProperty('reply_markup');
    expect(second.text).toBe('x\n\nOpen: http://localhost:5173/a');
  });

  it('sends action buttons as callback buttons, and keeps them on the plain fallback', async () => {
    const fetchMock = stubFetch(
      { status: 400, body: { ok: false, description: 'Bad Request: BUTTON_URL_INVALID' } },
      { status: 200, body: { ok: true, result: { message_id: 5 } } },
    );
    await adapter.postMessage({ token: 'T', botUsername: BOT, serverUrl: null, actionUrl: '' }, { chatId: '42' }, {
      text: 'x',
      plain: 'x',
      buttons: [[{ label: 'Open', url: 'http://localhost:5173/a' }], [{ label: '👍', action: 'v:a:u' }]],
    });
    const first = JSON.parse(fetchMock.mock.calls[0][1].body as string) as { reply_markup: unknown };
    expect(first.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'Open', url: 'http://localhost:5173/a' }], [{ text: '👍', callback_data: 'v:a:u' }]],
    });
    const second = JSON.parse(fetchMock.mock.calls[1][1].body as string) as { reply_markup: unknown; text: string };
    expect(second.reply_markup).toEqual({ inline_keyboard: [[{ text: '👍', callback_data: 'v:a:u' }]] });
    expect(second.text).toBe('x\n\nOpen: http://localhost:5173/a');
  });

  it('acknowledges a press with a short note', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true, result: true } });
    await adapter.acknowledge({ token: 'T', botUsername: BOT, serverUrl: null, actionUrl: '' }, 'cb-1', 'Thanks');
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/answerCallbackQuery$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toEqual({ callback_query_id: 'cb-1', text: 'Thanks' });
  });

  it('registers the webhook for questions and button presses', async () => {
    const fetchMock = stubFetch({ status: 200, body: { ok: true, result: true } });
    await adapter.registerWebhook({ token: 'T', botUsername: BOT, serverUrl: null, actionUrl: '' }, 'https://kn.test/hook', 's');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({
      allowed_updates: ['message', 'callback_query'],
    });
  });

  it('never puts the token in an error', async () => {
    stubFetch({ status: 401, body: { ok: false, description: 'Unauthorized' } });
    const err = await adapter.identify({ token: 'T0KEN', botUsername: null, serverUrl: null, actionUrl: '' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChatPlatformError);
    expect(String((err as Error).message)).toBe('telegram getMe: Unauthorized');
    expect(String((err as Error).message)).not.toContain('T0KEN');
  });

  it('treats "message is not modified" on an edit as done', async () => {
    stubFetch({ status: 400, body: { ok: false, description: 'Bad Request: message is not modified' } });
    await expect(
      adapter.editMessage({ token: 'T', botUsername: BOT, serverUrl: null, actionUrl: '' }, { chatId: '1', messageId: '2' }, { text: 'a', plain: 'a', buttons: [] }),
    ).resolves.toBeUndefined();
  });
});
