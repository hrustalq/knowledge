import { describe, expect, it, vi } from 'vitest';
import {
  communityHierarchy,
  graphFingerprint,
  groupCommunities,
  HUB_ENTITY_PAGES,
  louvain,
  MAX_COMMUNITY_LEVELS,
  pagePairs,
  type WeightedPair,
} from '../src/agents/communities.js';
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

describe('louvain self-loops', () => {
  it('counts a self-loop towards degree and never moves along it', () => {
    // Two heavy nodes (internal weight 10) joined by a thin link stay apart;
    // without the self-loops the thin link alone would merge them.
    const pairs = [
      { a: 'x', b: 'x', weight: 10 },
      { a: 'y', b: 'y', weight: 10 },
      { a: 'x', b: 'y', weight: 1 },
    ];
    expect(new Set(louvain(pairs).values()).size).toBe(2);
    expect(new Set(louvain([{ a: 'x', b: 'y', weight: 1 }]).values()).size).toBe(1);
  });
});

describe('communityHierarchy (#475)', () => {
  const clique = (ids: string[], weight: number): WeightedPair[] => ids.flatMap((a, i) => ids.slice(i + 1).map((b) => ({ a, b, weight })));
  const bridge = (a: string, b: string, weight: number): WeightedPair => ({ a, b, weight });
  // Four triangles; a–b and c–d are close neighbours, the two pairs barely touch.
  const pairs = [
    ...clique(['a1', 'a2', 'a3'], 4),
    ...clique(['b1', 'b2', 'b3'], 4),
    ...clique(['c1', 'c2', 'c3'], 4),
    ...clique(['d1', 'd2', 'd3'], 4),
    bridge('a1', 'b1', 3),
    bridge('a2', 'b2', 3),
    bridge('c1', 'd1', 3),
    bridge('c2', 'd2', 3),
    bridge('b3', 'c3', 1),
  ];
  const tree = communityHierarchy(pairs);

  it('builds at least two levels, and every non-root has a parent one or more levels up', () => {
    const levels = new Set(tree.map((n) => n.level));
    expect(levels.size).toBeGreaterThanOrEqual(2);
    expect(Math.max(...levels)).toBeLessThan(MAX_COMMUNITY_LEVELS);
    const byId = new Map(tree.map((n) => [n.id, n]));
    for (const n of tree.filter((x) => x.parentId)) {
      const parent = byId.get(n.parentId!)!;
      expect(parent.level).toBeGreaterThan(n.level);
      expect(parent.children).toContain(n.id);
    }
  });

  it('gives each level 0 its triangle and each level 1 two of them, members being every page beneath', () => {
    expect(tree.filter((n) => n.level === 0).map((n) => n.members)).toEqual([
      ['a1', 'a2', 'a3'],
      ['b1', 'b2', 'b3'],
      ['c1', 'c2', 'c3'],
      ['d1', 'd2', 'd3'],
    ]);
    expect(tree.filter((n) => n.level === 1).map((n) => [n.id, n.children, n.members.length])).toEqual([
      ['1:a1', ['0:a1', '0:b1'], 6],
      ['1:c1', ['0:c1', '0:d1'], 6],
    ]);
  });

  it('is deterministic', () => {
    expect(communityHierarchy([...pairs].reverse())).toEqual(tree);
  });

  it('stops at one level when nothing merges, and never past the cap', () => {
    const alone = communityHierarchy([...clique(['a1', 'a2', 'a3'], 4), ...clique(['b1', 'b2', 'b3'], 4)]);
    expect(alone.map((n) => [n.level, n.parentId])).toEqual([
      [0, null],
      [0, null],
    ]);
    // A long chain of triangles keeps merging; the tree still has at most MAX levels.
    const chain = Array.from({ length: 16 }, (_, i) => [
      ...clique([`p${i}a`, `p${i}b`, `p${i}c`], 4),
      ...(i ? [bridge(`p${i - 1}a`, `p${i}a`, 3)] : []),
    ]).flat();
    expect(Math.max(...communityHierarchy(chain).map((n) => n.level))).toBeLessThan(MAX_COMMUNITY_LEVELS);
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
    { communityId: 'c1', level: 0, parentId: 'top', title: 'Payments', summary: 'Billing and webhooks.', members: ['d1', 'd2'], builtAt: 0, score: 0.9 },
    { communityId: 'c2', level: 0, parentId: 'top', title: 'Secrets', summary: 'Restricted.', members: ['d3', 'd4'], builtAt: 0, score: 0.5 },
    { communityId: 'top', level: 1, parentId: null, title: 'Finance', summary: 'Payments and secrets.', members: ['d1', 'd2', 'd3', 'd4'], builtAt: 0, score: 0.7 },
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

  it('withholds an ancestor of a withheld community too (#475)', async () => {
    const { svc } = service(['d1', 'd2', 'd3']);
    expect(await svc.overview(systemScope(WS), undefined, 10, 1)).toEqual([]);
    const all = service(['d1', 'd2', 'd3', 'd4']).svc;
    expect((await all.overview(systemScope(WS), undefined, 10, 1)).map((c) => [c.communityId, c.level, c.parentId])).toEqual([['top', 1, null]]);
  });

  it('reads level 0 when no level is asked for', async () => {
    const { svc } = service(['d1', 'd2', 'd3', 'd4']);
    expect((await svc.overview(systemScope(WS), undefined, 10)).map((c) => c.communityId)).toEqual(['c1', 'c2']);
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
