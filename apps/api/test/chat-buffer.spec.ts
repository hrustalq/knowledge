import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { ChatBufferService } from '../src/chat/chat-buffer.service.js';
import { ChatIntegrationsService } from '../src/chat/chat-integrations.service.js';
import { HarvestRefused } from '../src/chat/harvest.service.js';
import type { ChatInbound } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * Telegram's listening buffer and DM forwards (#82, phase 3). What is pinned:
 * raw text never reaches a row; a group harvest reads M and what the group
 * said after it, and says when that is partial; forwards are exactly what was
 * forwarded; rows go at the TTL, at the window, on /forget, and when an admin
 * turns listening off — and listening only turns on once the group was told.
 */

const EMAIL = 'alice.smith@example.com';
const CARD = '4111 1111 1111 1111';
const config = { get: (k: string) => ({ CHAT_LISTEN_TTL_DAYS: 7, HARVEST_FORWARD_WINDOW_SEC: 120 })[k] };
const binding = { id: 'b-1', listening: true } as never;

function inbound(over: Partial<ChatInbound> = {}): ChatInbound {
  return {
    externalUserId: '42',
    externalUserName: '@alice',
    chatId: '-1001',
    chatTitle: 'Platform team',
    isDm: false,
    messageId: '30',
    text: `Mail ${EMAIL}, card ${CARD}`,
    mentioned: false,
    replyToBotMessageId: null,
    threadId: null,
    command: null,
    action: null,
    at: new Date('2026-10-19T12:00:00Z'),
    ...over,
  };
}

function buffer(rows: Array<{ id?: string; authorId: string; text: string; sentAt: Date }> = [], held = 1) {
  const prisma = {
    chatBufferedMessage: {
      createMany: vi.fn(async () => ({ count: 1 })),
      count: vi.fn(async () => held),
      findMany: vi.fn(async () => rows),
      deleteMany: vi.fn(async () => ({ count: 2 })),
    },
  };
  return { svc: new ChatBufferService(prisma as never, config as never), db: prisma.chatBufferedMessage };
}

describe('keeping', () => {
  it('a group message is masked before it is written', async () => {
    const { svc, db } = buffer();
    await svc.holdGroupMessage('int-1', binding, inbound({ topicId: '77' }));
    const row = (db.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>>; skipDuplicates: boolean }])[0];
    expect(row.skipDuplicates).toBe(true);
    expect(row.data[0]).toMatchObject({ bindingId: 'b-1', topicId: '77', authorId: '42', text: 'Mail [EMAIL_1], card [CARD_1]' });
    expect(JSON.stringify(row)).not.toContain(EMAIL);
  });

  it('a forward keeps its original author and time, masked, and says whether it opens a batch', async () => {
    const { svc, db } = buffer([], 0);
    const at = new Date('2026-10-18T09:00:00Z');
    expect(await svc.holdForward('int-1', inbound({ isDm: true, chatId: '42', forwardedFrom: { authorId: '9', at } }))).toBe(true);
    const row = (db.createMany.mock.calls[0] as unknown as [{ data: Array<Record<string, unknown>> }])[0].data[0];
    expect(row).toMatchObject({ authorId: '9', sentAt: at, text: 'Mail [EMAIL_1], card [CARD_1]' });
    expect(row.bindingId).toBeUndefined();
  });
});

describe('reading', () => {
  const M = { messageId: '11', authorId: '7', text: 'Ship on Tuesdays?', at: new Date('2026-10-19T10:00:00Z'), fromBot: false };
  const cmd = inbound({ messageId: '20', command: { name: 'capture', args: '' }, replyTo: M });

  it('listening off: M alone, and the note says so', async () => {
    const { svc, db } = buffer();
    const read = await svc.groupThread('int-1', { id: 'b-1', listening: false } as never, cmd, 200, 'https://t.me/c/1/11');
    expect(read.thread.messages).toEqual([{ authorId: '7', text: 'Ship on Tuesdays?', at: M.at }]);
    expect(read.thread.url).toBe('https://t.me/c/1/11');
    expect(read.note).toBe('chat.harvest.listeningOff');
    expect(db.findMany).not.toHaveBeenCalled();
  });

  it('listening on: M, then this topic’s kept messages from M up to the command, oldest first', async () => {
    const { svc, db } = buffer([
      { authorId: '42', text: 'Agreed.', sentAt: new Date('2026-10-19T10:02:00Z') },
      { authorId: '7', text: 'Yes, Tuesdays.', sentAt: new Date('2026-10-19T10:01:00Z') },
    ]);
    const read = await svc.groupThread('int-1', binding, { ...cmd, topicId: '77' }, 200, null);
    expect(read.thread.messages.map((m) => m.text)).toEqual(['Ship on Tuesdays?', 'Yes, Tuesdays.', 'Agreed.']);
    expect(read.note).toBeNull();
    const where = (db.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where).toMatchObject({ externalChatId: '-1001', topicId: '77', externalMessageId: { notIn: ['11', '20'] }, sentAt: { gte: M.at, lte: cmd.at } });
  });

  it('M older than the buffer: what is kept, and the note says the read is partial', async () => {
    const { svc } = buffer([], 0);
    const read = await svc.groupThread('int-1', binding, cmd, 200, null);
    expect(read.note).toBe('chat.harvest.beforeBuffer');
  });

  it('over the cap: M and the newest replies, marked truncated', async () => {
    const rows = [3, 2, 1].map((n) => ({ authorId: 'x', text: `r${n}`, sentAt: new Date(n * 1000) }));
    const { svc } = buffer(rows);
    const read = await svc.groupThread('int-1', binding, cmd, 3, null);
    expect(read.thread.messages.map((m) => m.text)).toEqual(['Ship on Tuesdays?', 'r2', 'r3']);
    expect(read.thread.truncated).toBe(true);
  });

  it('forwards: exactly what was forwarded, all of it consumed; none is a refusal', async () => {
    const { svc } = buffer([
      { id: 'f1', authorId: '9', text: 'a', sentAt: new Date(1) },
      { id: 'f2', authorId: '8', text: 'b', sentAt: new Date(2) },
    ]);
    const read = await svc.forwards('int-1', '42', 200);
    expect(read.thread.messages.map((m) => m.authorId)).toEqual(['9', '8']);
    expect(read.consumed).toEqual(['f1', 'f2']);
    await expect(buffer([]).svc.forwards('int-1', '42', 200)).rejects.toEqual(new HarvestRefused('chat.harvest.forwardFirst'));
  });
});

describe('dropping', () => {
  it('past the TTL for a group, past the window for a DM', async () => {
    const { svc, db } = buffer();
    const now = Date.parse('2026-10-19T12:00:00Z');
    await svc.purgeExpired(now);
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { bindingId: { not: null }, createdAt: { lt: new Date(now - 7 * 86_400_000) } },
          { bindingId: null, createdAt: { lt: new Date(now - 120_000) } },
        ],
      },
    });
  });

  it('/forget: the person’s own rows, and in a DM their forwards', async () => {
    const { svc, db } = buffer();
    await svc.forget('int-1', inbound({ isDm: true, chatId: '42' }));
    expect(db.deleteMany).toHaveBeenCalledWith({
      where: { integrationId: 'int-1', OR: [{ authorId: '42' }, { externalChatId: '42', bindingId: null }] },
    });
  });
});

describe('the listening switch', () => {
  function integrations(kind: string, post: () => Promise<unknown> = async () => ({})) {
    const row = { id: 'b-1', integrationId: 'int-1', workspaceId: 'ws', externalChatId: '-1001', listening: false, locale: null };
    const prisma = {
      chatChannelBinding: {
        findUnique: vi.fn(async () => row),
        update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data, _count: { subscriptions: 0 }, createdAt: new Date(), updatedAt: new Date() })),
      },
      chatIntegration: { findUnique: vi.fn(async () => ({ id: 'int-1', kind, locale: 'en' })) },
      chatBufferedMessage: { deleteMany: vi.fn(async () => ({ count: 4 })) },
    };
    const adapter = { postMessage: vi.fn(post), render: (v: unknown) => v };
    const cfg = { get: (k: string) => ({ API_PUBLIC_URL: 'https://api.test', CHAT_LISTEN_TTL_DAYS: 7 })[k] };
    const svc = new ChatIntegrationsService(prisma as never, { get: () => adapter } as never, {} as never, cfg as never);
    vi.spyOn(svc, 'require').mockResolvedValue({ id: 'int-1', kind, locale: 'en' } as never);
    vi.spyOn(svc, 'context').mockReturnValue({ token: 'T' } as never);
    return { svc, prisma, adapter, row };
  }

  it('on: tells the group first, then keeps', async () => {
    const h = integrations('telegram');
    const entry = await h.svc.updateBinding('b-1', { listening: true });
    expect(h.adapter.postMessage).toHaveBeenCalledWith({ token: 'T' }, { chatId: '-1001' }, { kind: 'notice', text: 'chat.listen.on' });
    expect(entry.listening).toBe(true);
  });

  it('on, but the group could not be told: nothing is kept', async () => {
    const h = integrations('telegram', async () => {
      throw new Error('bot was kicked');
    });
    await expect(h.svc.updateBinding('b-1', { listening: true })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.prisma.chatChannelBinding.update).not.toHaveBeenCalled();
  });

  it('off: what was kept goes at once', async () => {
    const h = integrations('telegram');
    h.row.listening = true;
    await h.svc.updateBinding('b-1', { listening: false });
    expect(h.prisma.chatBufferedMessage.deleteMany).toHaveBeenCalledWith({ where: { bindingId: 'b-1' } });
  });

  it('Time threads are read whole: no listening there', async () => {
    const h = integrations('time');
    await expect(h.svc.updateBinding('b-1', { listening: true })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('nothing else reads the buffer', () => {
  it('no search, assistant or MCP code touches chat_buffered_messages — a harvest is its only reader', () => {
    const src = join(import.meta.dirname, '../src');
    const readers = readdirSync(src, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts') && /chatBufferedMessage|chat_buffered_messages/.test(readFileSync(join(src, f), 'utf8')))
      .sort();
    // The integrations service only deletes (listening off).
    expect(readers).toEqual(['chat/chat-buffer.service.ts', 'chat/chat-integrations.service.ts']);
  });
});
