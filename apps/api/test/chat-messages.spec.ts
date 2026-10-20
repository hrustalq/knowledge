import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ChatIntegrationsService } from '../src/chat/chat-integrations.service.js';
import { ChatMessagesService } from '../src/chat/chat-messages.service.js';
import { MattermostAdapter } from '../src/chat/adapters/mattermost.adapter.js';
import { TelegramAdapter } from '../src/chat/adapters/telegram.adapter.js';
import type { ChatInbound } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * Searchable chat (#339, phase 1): the store. What is pinned: raw text never
 * reaches a row; an edit, a delete and /forget drop the chunk that held the
 * message, so it is packed again; the switch tells the group first and turns
 * nothing on when it cannot; off deletes what was kept; the retention a
 * workspace asks for is clamped to the env ceiling; and both platforms report
 * edits (Mattermost deletions too) without them reading as new messages.
 */

const EMAIL = 'alice.smith@example.com';
const CARD = '4111 1111 1111 1111';
const binding = { id: 'b-1', workspaceId: 'ws-1' } as never;
const env: Record<string, unknown> = { CHAT_SEARCH_ENABLED: true, CHAT_SEARCH_RETENTION_DAYS: 90, API_PUBLIC_URL: 'https://api.test', CHAT_LISTEN_TTL_DAYS: 7 };
const config = { get: (k: string) => env[k] };

function inbound(over: Partial<ChatInbound> = {}): ChatInbound {
  return {
    externalUserId: '42',
    externalUserName: '@alice',
    chatId: 'ch-1',
    chatTitle: 'Platform team',
    isDm: false,
    messageId: 'p-30',
    text: `Mail ${EMAIL}, card ${CARD}`,
    mentioned: false,
    replyToBotMessageId: null,
    threadId: 'root-1',
    command: null,
    action: null,
    at: new Date('2026-10-19T12:00:00Z'),
    ...over,
  };
}

/**
 * `raw` answers every `$queryRaw` in order: the locked row for `change`, the
 * deleted rows for `forget`. The SQL itself was run against Postgres by hand
 * (#339 phase 2 PR); what is pinned here is what the service does with it.
 */
function store(raw: unknown[][] = [[{ id: 'm-1', chunk_id: 'c-1' }]], settings: { chatSearchRetentionDays: number | null } | null = null) {
  const answers = [...raw];
  const db = {
    $queryRaw: vi.fn(async () => answers.shift() ?? []),
    chatMessage: {
      createMany: vi.fn(async () => ({ count: 1 })),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    chatChunk: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    workspaceSettings: { findUnique: vi.fn(async () => settings), upsert: vi.fn(async () => ({})) },
  };
  const prisma = { ...db, $transaction: vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(db) : Promise.all(arg as unknown[]))) };
  return { svc: new ChatMessagesService(prisma as never, config as never), db };
}

describe('keeping', () => {
  it('masks before it writes, keyed by thread, and a redelivery is a no-op', async () => {
    const { svc, db } = store();
    await svc.keep(binding, inbound());
    const { data, skipDuplicates } = (db.chatMessage.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>>; skipDuplicates: boolean }])[0];
    expect(skipDuplicates).toBe(true);
    expect(data[0]).toMatchObject({ workspaceId: 'ws-1', bindingId: 'b-1', threadKey: 'root-1', externalMessageId: 'p-30', authorId: '42' });
    expect(data[0].text).not.toContain(EMAIL);
    expect(data[0].text).not.toContain('4111');
    expect(data[0].text).toContain('[EMAIL_1]');
  });

  it('a Telegram message is keyed by its forum topic, or by nothing', async () => {
    const { svc, db } = store();
    await svc.keep(binding, inbound({ threadId: null, topicId: '77' }));
    await svc.keep(binding, inbound({ threadId: null }));
    const keys = db.chatMessage.createMany.mock.calls.map((c) => (c as unknown as [{ data: Array<{ threadKey: string }> }])[0].data[0].threadKey);
    expect(keys).toEqual(['77', '']);
  });
});

describe('changes', () => {
  it('an edit is masked, and its chunk goes so the thread is packed again', async () => {
    const { svc, db } = store();
    await svc.change(binding, inbound({ change: 'edited', text: `now ${EMAIL}` }));
    expect(db.chatChunk.deleteMany).toHaveBeenCalledWith({ where: { id: 'c-1' } });
    const { where, data } = (db.chatMessage.update.mock.calls[0] as unknown as [{ where: unknown; data: { text: string; editedAt: Date } }])[0];
    expect(where).toEqual({ id: 'm-1' });
    expect(data.text).toBe('now [EMAIL_1]');
    expect(data.editedAt).toEqual(new Date('2026-10-19T12:00:00Z'));
    expect(db.chatMessage.delete).not.toHaveBeenCalled();
  });

  it('a delete removes the row and its chunk', async () => {
    const { svc, db } = store();
    await svc.change(binding, inbound({ change: 'deleted', text: '' }));
    expect(db.chatChunk.deleteMany).toHaveBeenCalledOnce();
    expect(db.chatMessage.delete).toHaveBeenCalledWith({ where: { id: 'm-1' } });
  });

  it('a change to a message never kept touches nothing', async () => {
    const { svc, db } = store([[]]);
    await svc.change(binding, inbound({ change: 'edited' }));
    expect(db.chatChunk.deleteMany).not.toHaveBeenCalled();
    expect(db.chatMessage.update).not.toHaveBeenCalled();
  });

  it('an unpacked message is edited with no chunk to drop', async () => {
    const { svc, db } = store([[{ id: 'm-1', chunk_id: null }]]);
    await svc.change(binding, inbound({ change: 'edited', text: 'x' }));
    expect(db.chatChunk.deleteMany).not.toHaveBeenCalled();
    expect(db.chatMessage.update).toHaveBeenCalledOnce();
  });

  it('/forget drops the chunks the deleted rows were in, each once, and counts the rows', async () => {
    const { svc, db } = store([[{ chunk_id: 'c-1' }, { chunk_id: 'c-1' }, { chunk_id: null }, { chunk_id: 'c-2' }]]);
    expect(await svc.forget('int-1', '42')).toBe(4);
    expect(db.chatChunk.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['c-1', 'c-2'] } } });
  });
});

describe('retention', () => {
  it('inherits the ceiling, may shorten it, and is clamped to it', async () => {
    expect((await store([], null).svc.settings('ws-1')).retentionDays).toEqual({ ceiling: 90, requested: null, applied: 90 });
    expect((await store([], { chatSearchRetentionDays: 30 }).svc.settings('ws-1')).retentionDays.applied).toBe(30);
    expect((await store([], { chatSearchRetentionDays: 400 }).svc.settings('ws-1')).retentionDays).toEqual({ ceiling: 90, requested: 400, applied: 90 });
  });
});

describe('the searchable switch', () => {
  function integrations(post: () => Promise<unknown> = async () => ({}), row: Record<string, unknown> = {}) {
    const binding = { id: 'b-1', integrationId: 'int-1', workspaceId: 'ws-1', externalChatId: 'ch-1', listening: false, searchableAt: null, locale: null, ...row };
    const prisma = {
      chatChannelBinding: {
        findUnique: vi.fn(async () => binding),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...binding, ...data, _count: { subscriptions: 0 }, createdAt: new Date(), updatedAt: new Date() })),
      },
    };
    const adapter = { postMessage: vi.fn(post), render: (v: unknown) => v };
    const messages = {
      enabled: env.CHAT_SEARCH_ENABLED,
      settings: vi.fn(async () => ({ available: true, retentionDays: { ceiling: 90, requested: 30, applied: 30 } })),
      purgeBinding: vi.fn(async () => undefined),
    };
    const svc = new ChatIntegrationsService(prisma as never, { get: () => adapter } as never, {} as never, config as never, messages as never);
    vi.spyOn(svc, 'require').mockResolvedValue({ id: 'int-1', kind: 'mattermost', locale: 'en' } as never);
    vi.spyOn(svc, 'context').mockReturnValue({ token: 'T' } as never);
    return { svc, prisma, adapter, messages };
  }

  it('on, on any platform: tells the group the applied retention first, and the caller becomes who turned it on', async () => {
    const h = integrations();
    const entry = await h.svc.updateBinding('b-1', { searchable: true }, 'admin-1');
    expect(h.adapter.postMessage).toHaveBeenCalledWith({ token: 'T' }, { chatId: 'ch-1' }, { kind: 'notice', text: 'chat.search.on' });
    expect(entry.searchableBy).toBe('admin-1');
    expect(entry.searchableAt).not.toBeNull();
  });

  it('a notice that cannot be posted switches nothing on', async () => {
    const h = integrations(async () => {
      throw new Error('bot was kicked');
    });
    await expect(h.svc.updateBinding('b-1', { searchable: true }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.chatChannelBinding.update).not.toHaveBeenCalled();
  });

  it('refused while CHAT_SEARCH_ENABLED is off', async () => {
    env.CHAT_SEARCH_ENABLED = false;
    try {
      const h = integrations();
      await expect(h.svc.updateBinding('b-1', { searchable: true }, 'admin-1')).rejects.toBeInstanceOf(BadRequestException);
      expect(h.adapter.postMessage).not.toHaveBeenCalled();
    } finally {
      env.CHAT_SEARCH_ENABLED = true;
    }
  });

  it('off deletes what was kept at once, and says nothing in the group', async () => {
    const h = integrations(undefined, { searchableAt: new Date(), searchableBy: 'admin-1' });
    const entry = await h.svc.updateBinding('b-1', { searchable: false }, 'admin-2');
    expect(h.messages.purgeBinding).toHaveBeenCalledWith('b-1');
    expect(h.adapter.postMessage).not.toHaveBeenCalled();
    expect(entry.searchableBy).toBeNull();
  });

  it('asking for the state it is already in does nothing', async () => {
    const h = integrations(undefined, { searchableAt: new Date(), searchableBy: 'admin-1' });
    const entry = await h.svc.updateBinding('b-1', { searchable: true }, 'admin-2');
    expect(h.adapter.postMessage).not.toHaveBeenCalled();
    expect(entry.searchableBy).toBe('admin-1');
  });
});

describe('platform changes', () => {
  it('Telegram: an edited_message is the edit, timed by edit_date', () => {
    const body = JSON.stringify({
      update_id: 1,
      edited_message: { message_id: 30, date: 1_760_000_000, edit_date: 1_760_000_600, from: { id: 42, is_bot: false, first_name: 'A' }, chat: { id: -1001, type: 'supergroup' }, text: 'fixed typo' },
    });
    const [m] = new TelegramAdapter('https://api.telegram.org').parseInbound({ headers: {}, body }, 'kbot');
    expect(m).toMatchObject({ messageId: '30', text: 'fixed typo', change: 'edited', at: new Date(1_760_000_600_000) });
  });

  it('Mattermost: post_edited and post_deleted, never a bot’s own', () => {
    const adapter = new MattermostAdapter('mattermost', false);
    const post = { id: 'p-30', user_id: 'u-1', channel_id: 'ch-1', root_id: 'root-1', message: 'new text', edit_at: 1_760_000_600_000 };
    const edited = adapter.parseInbound({ headers: {}, body: JSON.stringify({ event: 'post_edited', data: { post: JSON.stringify(post) } }) }, 'kbot');
    expect(edited).toEqual([expect.objectContaining({ messageId: 'p-30', text: 'new text', threadId: 'root-1', change: 'edited', at: new Date(1_760_000_600_000) })]);
    const deleted = adapter.parseInbound({ headers: {}, body: JSON.stringify({ event: 'post_deleted', data: { post: JSON.stringify({ ...post, delete_at: 1 }) } }) }, 'kbot');
    expect(deleted).toEqual([expect.objectContaining({ messageId: 'p-30', change: 'deleted', text: '' })]);
    const own = { ...post, props: { from_bot: 'true' } };
    expect(adapter.parseInbound({ headers: {}, body: JSON.stringify({ event: 'post_edited', data: { post: JSON.stringify(own) } }) }, 'kbot')).toEqual([]);
  });
});
