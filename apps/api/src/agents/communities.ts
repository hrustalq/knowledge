/**
 * Communities of pages for global questions (#81, phase 7), Nest-free.
 *
 * The graph is bipartite (page → entity), so communities are found on its
 * page-to-page projection: two pages are linked by every entity they both
 * name, weighted by how many. Louvain modularity optimisation over that says
 * "these pages are about one area"; repeated on the aggregated graph (#475)
 * it says which areas belong together, up to MAX_COMMUNITY_LEVELS. The
 * summaries do the rest. Deterministic (ids in sorted order), so the same
 * graph gives the same tree, and its fingerprint says when a rebuild is worth it.
 */
import { createHash } from 'node:crypto';

/** An entity named by more pages than this is a hub, and links nothing in particular. */
export const HUB_ENTITY_PAGES = 12;
/** A Louvain level stops after this many passes even if nodes still move. */
const MAX_PASSES = 20;
/** Levels 0 (finest) … 2 (docs/features/63). */
export const MAX_COMMUNITY_LEVELS = 3;
/**
 * Level L runs Louvain at resolution RESOLUTION_STEP^L. At resolution 1 a
 * converged level 0 is already a modularity optimum, so aggregating merges
 * almost nothing; halving it per level is what finds the coarser grouping.
 */
const RESOLUTION_STEP = 0.5;
/** Bumped when the tree's shape changes, so the first run after a deploy rebuilds an unchanged graph. */
const HIERARCHY_VERSION = 'levels-v1';

export interface WeightedPair {
  a: string;
  b: string;
  weight: number;
}

/** Page-to-page links from (page, entity) edges: one unit of weight per shared entity. */
export function pagePairs(edges: ReadonlyArray<{ documentId: string; targetKey: string }>): WeightedPair[] {
  const pagesOf = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!pagesOf.has(e.targetKey)) pagesOf.set(e.targetKey, new Set());
    pagesOf.get(e.targetKey)!.add(e.documentId);
  }
  const weights = new Map<string, number>();
  for (const pages of pagesOf.values()) {
    if (pages.size < 2 || pages.size > HUB_ENTITY_PAGES) continue;
    const ids = [...pages].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const key = `${ids[i]} ${ids[j]}`;
        weights.set(key, (weights.get(key) ?? 0) + 1);
      }
    }
  }
  return sortedPairs(weights);
}

/** `"a b" → weight` as pairs, in key order, so the same links always come out the same way. */
function sortedPairs(weights: ReadonlyMap<string, number>): WeightedPair[] {
  return [...weights].sort(([x], [y]) => x.localeCompare(y)).map(([key, weight]) => {
    const [a, b] = key.split(' ') as [string, string];
    return { a, b, weight };
  });
}

/**
 * One level of Louvain: each node starts alone, and in turn moves to the
 * neighbouring community that raises modularity most, until a pass moves
 * nobody. Returns node → community label (the smallest node id in it).
 *
 * A pair with `a === b` is a self-loop: on an aggregated graph it carries a
 * community's internal weight, which counts twice towards its degree and
 * never as a link to move along. `resolution` below 1 favours larger
 * communities (the γ of generalised modularity).
 */
export function louvain(pairs: readonly WeightedPair[], resolution = 1): Map<string, string> {
  const adj = new Map<string, Map<string, number>>();
  const self = new Map<string, number>();
  const link = (x: string, y: string, w: number) => {
    if (!adj.has(x)) adj.set(x, new Map());
    adj.get(x)!.set(y, (adj.get(x)!.get(y) ?? 0) + w);
  };
  for (const { a, b, weight } of pairs) {
    if (a === b) {
      if (!adj.has(a)) adj.set(a, new Map());
      self.set(a, (self.get(a) ?? 0) + weight);
      continue;
    }
    link(a, b, weight);
    link(b, a, weight);
  }
  const nodes = [...adj.keys()].sort();
  const degree = new Map(nodes.map((n) => [n, [...adj.get(n)!.values()].reduce((s, w) => s + w, 2 * (self.get(n) ?? 0))]));
  const m2 = [...degree.values()].reduce((s, d) => s + d, 0); // 2m
  const community = new Map(nodes.map((n) => [n, n]));
  const total = new Map(nodes.map((n) => [n, degree.get(n)!])); // Σtot per community
  if (m2 === 0) return community;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false;
    for (const n of nodes) {
      const own = community.get(n)!;
      const k = degree.get(n)!;
      // Weight from n into each neighbouring community.
      const into = new Map<string, number>();
      for (const [nb, w] of adj.get(n)!) {
        const c = community.get(nb)!;
        into.set(c, (into.get(c) ?? 0) + w);
      }
      total.set(own, total.get(own)! - k);
      // ΔQ of joining c, up to a constant: k_in/m − γ·Σtot·k/(2m²), scaled by 2m.
      const gain = (c: string) => 2 * (into.get(c) ?? 0) - (resolution * total.get(c)! * k * 2) / m2;
      let best = own;
      let bestGain = gain(own);
      for (const c of [...into.keys()].sort()) {
        const g = gain(c);
        if (g > bestGain + 1e-12) {
          best = c;
          bestGain = g;
        }
      }
      total.set(best, total.get(best)! + k);
      if (best !== own) {
        community.set(n, best);
        moved = true;
      }
    }
    if (!moved) break;
  }

  // Stable labels: a community is named after its smallest member.
  const label = new Map<string, string>();
  for (const n of nodes) {
    const c = community.get(n)!;
    if (!label.has(c) || n < label.get(c)!) label.set(c, n);
  }
  return new Map(nodes.map((n) => [n, label.get(community.get(n)!)!]));
}

/** Communities of at least `minSize` pages, largest first, each as its sorted member ids. */
export function groupCommunities(assignment: ReadonlyMap<string, string>, minSize: number): string[][] {
  const groups = new Map<string, string[]>();
  for (const [page, c] of assignment) {
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c)!.push(page);
  }
  return [...groups.values()]
    .filter((g) => g.length >= minSize)
    .map((g) => g.sort())
    .sort((x, y) => y.length - x.length || x[0]!.localeCompare(y[0]!));
}

/** One community of the tree: every page beneath it, and the community it merged into. */
export interface CommunityNode {
  /** `<level>:<smallest page id beneath>` — unique across levels. */
  id: string;
  level: number;
  /** Null for a root: nothing above merged it with another community. */
  parentId: string | null;
  /** Every page beneath, sorted — so "withheld whole" is one check per community. */
  members: string[];
  /** The communities it merged, one level or more below. Empty at level 0. */
  children: string[];
}

/**
 * The community tree (#475): level 0 is `groupCommunities(louvain(pairs))`,
 * and each level above runs Louvain on the roots so far, at a lower
 * resolution — nodes linked by the page-pair weight between them, their
 * internal weight a self-loop. A level
 * keeps only communities merging at least two roots; the rest stay roots and
 * take part in the next level. Stops when a level merges nothing, or at
 * MAX_COMMUNITY_LEVELS. Ordered by level, then largest first.
 */
export function communityHierarchy(pairs: readonly WeightedPair[]): CommunityNode[] {
  const nodes: CommunityNode[] = groupCommunities(louvain(pairs), 2).map((members) => ({
    id: `0:${members[0]}`,
    level: 0,
    parentId: null,
    members,
    children: [],
  }));
  let roots = [...nodes];
  for (let level = 1; level < MAX_COMMUNITY_LEVELS && roots.length > 1; level++) {
    const rootOf = new Map(roots.flatMap((r) => r.members.map((m) => [m, r.id] as const)));
    const weights = new Map<string, number>();
    for (const { a, b, weight } of pairs) {
      const [x, y] = [rootOf.get(a), rootOf.get(b)];
      if (!x || !y) continue;
      const key = x < y ? `${x} ${y}` : `${y} ${x}`;
      weights.set(key, (weights.get(key) ?? 0) + weight);
    }
    const byId = new Map(roots.map((r) => [r.id, r]));
    const merged = groupCommunities(louvain(sortedPairs(weights), RESOLUTION_STEP ** level), 2).map((ids): CommunityNode => {
      const members = ids.flatMap((id) => byId.get(id)!.members).sort();
      return { id: `${level}:${members[0]}`, level, parentId: null, members, children: ids };
    });
    if (merged.length === 0) break;
    for (const parent of merged) for (const id of parent.children) byId.get(id)!.parentId = parent.id;
    nodes.push(...merged.sort((x, y) => y.members.length - x.members.length || x.id.localeCompare(y.id)));
    roots = roots.filter((r) => r.parentId === null).concat(merged);
  }
  return nodes;
}

/** The projection's identity: unchanged links mean an unchanged answer, so the rebuild is skipped. */
export function graphFingerprint(pairs: readonly WeightedPair[]): string {
  return createHash('sha256')
    .update([HIERARCHY_VERSION, ...pairs.map((p) => `${p.a} ${p.b} ${p.weight}`)].join('\n'))
    .digest('hex');
}
