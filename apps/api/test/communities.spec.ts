import { describe, expect, it, vi } from 'vitest';
import { graphFingerprint, groupCommunities, HUB_ENTITY_PAGES, louvain, pagePairs } from '../src/agents/communities.js';
import { CommunitiesService } from '../src/communities/communities.service.js';
import { systemScope } from '../src/permissions/access-scope.js';

/** #81 phase 7 — communities of pages for global questions. */

const e = (documentId: string, targetKey: string) => ({ documentId, targetKey });

describe('pagePairs', () => {
  it('links pages by the entities they share, one unit of weight each', () => {
    const pairs = pagePairs([e('a', 'x'), e('b', 'x'), e('a', 'y'), e('b', 'y'), e('c', 'y')]);
    expect(pairs).toEqual([
      { a: 'a', b: 'b', weight: 2 },
      { a: 'a', b: 'c', weight: 1 },
      { a: 'b', b: 'c', weight: 1 },
    ]);
  });

  it('ignores a hub entity named by too many pages', () => {
    const hub = Array.from({ length: HUB_ENTITY_PAGES + 1 }, (_, i) => e(`p${i}`, 'tag:common'));
    expect(pagePairs(hub)).toEqual([]);
  });
});

describe('louvain', () => {
  // Two tight groups of four, one bridge between them.
  const clique = (ids: string[]) => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ a, b, weight: 3 })));
  const pairs = [...clique(['a1', 'a2', 'a3', 'a4']), ...clique(['b1', 'b2', 'b3', 'b4']), { a: 'a1', b: 'b1', weight: 1 }];

  it('finds the two groups and names each after its smallest member', () => {
    const groups = groupCommunities(louvain(pairs), 2);
    expect(groups).toEqual([
      ['a1', 'a2', 'a3', 'a4'],
      ['b1', 'b2', 'b3', 'b4'],
    ]);
    expect(louvain(pairs).get('a3')).toBe('a1');
  });

  it('is deterministic: the same graph in another order gives the same answer', () => {
    expect([...louvain([...pairs].reverse())].sort()).toEqual([...louvain(pairs)].sort());
  });

  it('drops groups below the minimum size', () => {
    expect(groupCommunities(louvain([{ a: 'x', b: 'y', weight: 1 }]), 3)).toEqual([]);
  });
});

describe('graphFingerprint', () => {
  it('changes when a link does, and only then', () => {
    const base = [{ a: 'a', b: 'b', weight: 1 }];
    expect(graphFingerprint(base)).toBe(graphFingerprint([{ a: 'a', b: 'b', weight: 1 }]));
    expect(graphFingerprint(base)).not.toBe(graphFingerprint([{ a: 'a', b: 'b', weight: 2 }]));
  });
});

describe('CommunitiesService', () => {
  const WS = '11111111-1111-4111-8111-111111111111';
  const stored = [
    { communityId: 'c1', title: 'Payments', summary: 'Billing and webhooks.', members: ['d1', 'd2'], builtAt: 0, score: 0.9 },
    { communityId: 'c2', title: 'Secrets', summary: 'Restricted.', members: ['d3', 'd4'], builtAt: 0, score: 0.5 },
  ];
  function service(visible: string[]) {
    const graph = { communities: vi.fn(async () => stored) };
    const prisma = { document: { findMany: vi.fn(async () => visible.map((id) => ({ id, title: `T ${id}` }))) } };
    const embeddings = { embed: vi.fn(async () => [1, 0]) };
    return { svc: new CommunitiesService(prisma as never, graph as never, embeddings as never), graph, embeddings };
  }

  it('withholds a community with any page the reader may not open', async () => {
    const { svc } = service(['d1', 'd2', 'd3']);
    const out = await svc.overview(systemScope(WS), 'payments', 10);
    expect(out.map((c) => c.communityId)).toEqual(['c1']);
    expect(out[0]!.documents).toEqual([
      { documentId: 'd1', title: 'T d1' },
      { documentId: 'd2', title: 'T d2' },
    ]);
  });

  it('ranks by the question when there is one, and embeds nothing without one', async () => {
    const { svc, embeddings, graph } = service(['d1', 'd2', 'd3', 'd4']);
    await svc.overview(systemScope(WS), undefined, 10);
    expect(embeddings.embed).not.toHaveBeenCalled();
    await svc.overview(systemScope(WS), 'what are our risks?', 10);
    expect(graph.communities).toHaveBeenLastCalledWith(WS, expect.any(Function), [1, 0]);
  });

  it('colours only pages of communities the reader may see whole', async () => {
    const { svc } = service(['d1', 'd2', 'd3']);
    expect([...(await svc.membership(systemScope(WS)))]).toEqual([
      ['d1', 'c1'],
      ['d2', 'c1'],
    ]);
  });
});
