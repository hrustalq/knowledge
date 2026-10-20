import { describe, expect, it, vi } from 'vitest';
import { ChatSearchService } from '../src/chat/chat-search.service.js';
import type { AccessScope } from '../src/permissions/access-scope.js';

/**
 * Chat search (#339, phase 3), the service on its own. What is pinned: the
 * readable bindings are decided before anything is embedded, and with none
 * nothing is; both legs are restricted to them; the final read drops a
 * vector whose row is gone; a Telegram supergroup hit links its first
 * message. The audience itself is pinned in permissions.spec.ts
 * (`canSeeChat`) and end to end in chat-search.e2e-spec.ts.
 */

const WS = 'ws-1';
const member: AccessScope = {
  workspaceId: WS,
  userId: 'u-1',
  role: 'editor',
  bypass: false,
  guest: false,
  readOnly: false,
  groupIds: new Set(),
  denied: new Set(['p-secret']),
  granted: new Set(),
};

function harness(opts: { textHits?: Array<{ chunkId: string; score: number }>; vectorHits?: Array<{ chunkId: string; score: number }> } = {}) {
  const bindings = [
    { id: 'b-open', projectId: 'p-open', title: '#ops', externalChatId: '-100123', integration: { kind: 'telegram' } },
    { id: 'b-secret', projectId: 'p-secret', title: '#pay', externalChatId: 'ch-2', integration: { kind: 'time' } },
  ];
  const chunk = (id: string, bindingId: string) => ({
    id,
    bindingId,
    workspaceId: WS,
    text: 'author-1: ship on Tuesdays',
    firstAt: new Date('2026-10-20T10:00:00Z'),
    lastAt: new Date('2026-10-20T10:05:00Z'),
    messageCount: 2,
  });
  const prisma = {
    chatChannelBinding: { findMany: vi.fn(async () => bindings) },
    project: { findMany: vi.fn(async () => [{ id: 'p-secret' }]) },
    $queryRaw: vi.fn(async () => opts.textHits ?? [{ chunkId: 'c-1', score: 0.5 }]),
    // c-gone has a vector and no row: deleted since.
    chatChunk: { findMany: vi.fn(async () => [chunk('c-1', 'b-open')]) },
    chatMessage: { findMany: vi.fn(async () => [{ chunkId: 'c-1', externalMessageId: '42' }]) },
  };
  const graph = { nearestChatChunks: vi.fn(async () => opts.vectorHits ?? [{ chunkId: 'c-gone', score: 0.9 }, { chunkId: 'c-1', score: 0.8 }]) };
  const embeddings = { embed: vi.fn(async () => [0.1, 0.2]) };
  return { svc: new ChatSearchService(prisma as never, graph as never, embeddings as never), prisma, graph, embeddings };
}

describe('chat search', () => {
  it('searches only the readable bindings, and the final read joins them again', async () => {
    const h = harness();
    const { hits } = await h.svc.search(member, { query: 'tuesday', limit: 10 });
    expect(h.graph.nearestChatChunks).toHaveBeenCalledWith(WS, [0.1, 0.2], 40, ['b-open']);
    const [{ where }] = h.prisma.chatChunk.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(where).toMatchObject({ workspaceId: WS, bindingId: { in: ['b-open'] } });
    expect(hits.map((x) => x.chunkId)).toEqual(['c-1']);
    expect(hits[0]).toMatchObject({ bindingId: 'b-open', platform: 'telegram', chatTitle: '#ops', url: 'https://t.me/c/123/42', messageCount: 2 });
  });

  it('embeds nothing when no searchable group is readable', async () => {
    const h = harness();
    h.prisma.chatChannelBinding.findMany.mockResolvedValueOnce([
      { id: 'b-secret', projectId: 'p-secret', title: '#pay', externalChatId: 'ch-2', integration: { kind: 'time' } },
    ]);
    expect(await h.svc.search(member, { query: 'tuesday', limit: 10 })).toEqual({ hits: [] });
    expect(h.embeddings.embed).not.toHaveBeenCalled();
    expect(h.prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('a blank query reads nothing', async () => {
    const h = harness();
    expect(await h.svc.search(member, { query: '   ', limit: 10 })).toEqual({ hits: [] });
    expect(h.prisma.chatChannelBinding.findMany).not.toHaveBeenCalled();
  });

  it('passes the filters to the binding read, so they only narrow', async () => {
    const h = harness();
    await h.svc.search(member, { query: 'x', projectIds: ['p-open'], bindingIds: ['b-open'], limit: 5 });
    const [{ where }] = h.prisma.chatChannelBinding.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(where).toEqual({ workspaceId: WS, searchableAt: { not: null }, id: { in: ['b-open'] }, projectId: { in: ['p-open'] } });
  });

  it('a hit from a platform with no links carries none', async () => {
    const h = harness();
    h.prisma.chatChannelBinding.findMany.mockResolvedValueOnce([
      { id: 'b-open', projectId: 'p-open', title: '#ops', externalChatId: 'ch-1', integration: { kind: 'mattermost' } },
    ]);
    const { hits } = await h.svc.search(member, { query: 'x', limit: 5 });
    expect(hits[0].url).toBeNull();
  });
});
