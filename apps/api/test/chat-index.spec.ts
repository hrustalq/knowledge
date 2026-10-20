import { describe, expect, it, vi } from 'vitest';
import { ChatIndexSweeper } from '../src/chat/chat-index.sweeper.js';
import { sealedWindows, windowText, type UnpackedMessage } from '../src/chat/chat-windows.js';

/**
 * Searchable chat (#339, phase 2): the indexer. What is pinned: windows split
 * at a silence and at the cap, and the last waits for the thread to settle;
 * a window's text numbers its authors and names nobody; a pack writes the
 * vector before the row and gives the vector back when the window changed
 * under it; the reap removes only vectors with no row, and none still young.
 */

const MIN = 60_000;
const T0 = Date.parse('2026-10-20T10:00:00Z');
const rules = { maxMessages: 3, gapMs: 30 * MIN, settleMs: 10 * MIN };
const msg = (id: string, minute: number, authorId = 'u-1', text = `said ${id}`): UnpackedMessage => ({ id, authorId, text, sentAt: new Date(T0 + minute * MIN) });

describe('windows', () => {
  it('split at a silence and at the cap; every window but the last is ready', () => {
    const thread = [msg('a', 0), msg('b', 1), msg('c', 2), msg('d', 3), msg('e', 60), msg('f', 61)];
    const ids = (ws: UnpackedMessage[][]) => ws.map((w) => w.map((m) => m.id).join(''));
    // At minute 65 the last window is 4 minutes old: not settled, held back.
    expect(ids(sealedWindows(thread, rules, T0 + 65 * MIN))).toEqual(['abc', 'd']);
    // Quiet for 10 minutes: it goes too.
    expect(ids(sealedWindows(thread, rules, T0 + 71 * MIN))).toEqual(['abc', 'd', 'ef']);
  });

  it('a full last window does not wait', () => {
    expect(sealedWindows([msg('a', 0), msg('b', 1), msg('c', 2)], rules, T0 + 3 * MIN)).toHaveLength(1);
  });

  it('nothing is ready in a live thread with one short window', () => {
    expect(sealedWindows([msg('a', 0)], rules, T0 + 5 * MIN)).toEqual([]);
  });

  it('a window numbers its authors in order of first appearance, and names nobody', () => {
    expect(windowText([msg('a', 0, 'U9', 'ship it?'), msg('b', 1, 'U3', 'yes'), msg('c', 2, 'U9', 'ok')])).toBe(
      'author-1: ship it?\nauthor-2: yes\nauthor-1: ok',
    );
  });
});

function harness(opts: { locked?: Array<{ id: string; text: string }>; vectors?: Array<{ chunkId: string; writtenAt: number }>; kept?: string[] } = {}) {
  const thread = [msg('m-1', 0, 'U9', 'deploys on Tuesday'), msg('m-2', 1, 'U3', 'agreed')];
  const tx = {
    $queryRaw: vi.fn(async () => opts.locked ?? thread.map((m) => ({ id: m.id, text: m.text }))),
    chatChunk: { create: vi.fn(async () => ({})) },
    chatMessage: { updateMany: vi.fn(async () => ({ count: 2 })) },
  };
  const order: string[] = [];
  const prisma = {
    $queryRaw: vi.fn(async () => [{ binding_id: 'b-1', thread_key: 'root-1' }]),
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => {
      order.push('row');
      return fn(tx);
    }),
    chatChannelBinding: { findUnique: vi.fn(async () => ({ workspaceId: 'ws-1', title: 'Platform team' })) },
    chatMessage: { findMany: vi.fn(async () => thread) },
    chatChunk: { findMany: vi.fn(async () => (opts.kept ?? []).map((id) => ({ id }))) },
    workspace: { findMany: vi.fn(async () => [{ id: 'ws-1' }]) },
  };
  const graph = {
    upsertChatChunk: vi.fn(async () => {
      order.push('vector');
    }),
    deleteChatChunks: vi.fn(async () => undefined),
    chatChunkIds: vi.fn(async () => opts.vectors ?? []),
  };
  const embeddings = { embedBatch: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2])) };
  const env: Record<string, number> = { CHAT_SEARCH_WINDOW_MESSAGES: 20, CHAT_SEARCH_WINDOW_GAP_MIN: 30, CHAT_SEARCH_SETTLE_MIN: 10, CHAT_SEARCH_TICK_SEC: 60 };
  const sweeper = new ChatIndexSweeper(prisma as never, graph as never, embeddings as never, { get: (k: string) => env[k] } as never);
  return { sweeper, prisma, tx, graph, embeddings, order };
}

describe('packing', () => {
  const settled = T0 + 30 * MIN;

  it('embeds with the group title, writes the vector, then the row and the messages’ chunk', async () => {
    const h = harness();
    expect(await h.sweeper.sweep(settled)).toBe(1);
    expect(h.embeddings.embedBatch).toHaveBeenCalledWith(['Platform team\nauthor-1: deploys on Tuesday\nauthor-2: agreed']);
    expect(h.order).toEqual(['vector', 'row']);
    const [{ data }] = h.tx.chatChunk.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }];
    expect(data).toMatchObject({ workspaceId: 'ws-1', bindingId: 'b-1', threadKey: 'root-1', messageCount: 2, text: 'author-1: deploys on Tuesday\nauthor-2: agreed' });
    expect(data.text).not.toContain('Platform team');
    const [{ where, data: attached }] = h.tx.chatMessage.updateMany.mock.calls[0] as unknown as [{ where: unknown; data: { chunkId: string } }];
    expect(where).toEqual({ id: { in: ['m-1', 'm-2'] } });
    expect(attached.chunkId).toBe(data.id);
    expect(h.graph.deleteChatChunks).not.toHaveBeenCalled();
  });

  it('a message edited or deleted under the pack: no row, and the vector is given back', async () => {
    for (const locked of [[{ id: 'm-1', text: 'deploys on Wednesday' }, { id: 'm-2', text: 'agreed' }], [{ id: 'm-2', text: 'agreed' }]]) {
      const h = harness({ locked });
      expect(await h.sweeper.sweep(settled)).toBe(0);
      expect(h.tx.chatChunk.create).not.toHaveBeenCalled();
      expect(h.graph.deleteChatChunks).toHaveBeenCalledOnce();
    }
  });

  it('a thread not yet settled is not embedded', async () => {
    const h = harness();
    expect(await h.sweeper.sweep(T0 + 5 * MIN)).toBe(0);
    expect(h.embeddings.embedBatch).not.toHaveBeenCalled();
  });
});

describe('the reap', () => {
  it('every tenth tick removes vectors with no row, never one still young', async () => {
    const now = T0 + 60 * MIN;
    const h = harness({
      vectors: [
        { chunkId: 'kept', writtenAt: now - 60 * MIN },
        { chunkId: 'orphan', writtenAt: now - 60 * MIN },
        { chunkId: 'young', writtenAt: now - MIN },
      ],
      kept: ['kept'],
    });
    for (let i = 0; i < 9; i++) await h.sweeper.sweep(T0);
    expect(h.graph.chatChunkIds).not.toHaveBeenCalled();
    await h.sweeper.sweep(now);
    expect(h.prisma.chatChunk.findMany).toHaveBeenCalledWith({ where: { id: { in: ['kept', 'orphan'] } }, select: { id: true } });
    expect(h.graph.deleteChatChunks).toHaveBeenLastCalledWith('ws-1', ['orphan']);
  });
});
