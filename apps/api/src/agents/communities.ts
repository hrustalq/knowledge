/**
 * Communities of pages for global questions (#81, phase 7), Nest-free.
 *
 * The graph is bipartite (page → entity), so communities are found on its
 * page-to-page projection: two pages are linked by every entity they both
 * name, weighted by how many. One level of Louvain modularity optimisation
 * over that is enough to say "these pages are about one area" — the summaries
 * do the rest. Deterministic (ids in sorted order), so the same graph gives
 * the same communities, and its fingerprint says when a rebuild is worth it.
 */
import { createHash } from 'node:crypto';

/** An entity named by more pages than this is a hub, and links nothing in particular. */
export const HUB_ENTITY_PAGES = 12;
/** A Louvain level stops after this many passes even if nodes still move. */
const MAX_PASSES = 20;

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
  return [...weights].sort(([x], [y]) => x.localeCompare(y)).map(([key, weight]) => {
    const [a, b] = key.split(' ') as [string, string];
    return { a, b, weight };
  });
}

/**
 * One level of Louvain: each page starts alone, and in turn moves to the
 * neighbouring community that raises modularity most, until a pass moves
 * nobody. Returns page → community label (the smallest page id in it).
 */
export function louvain(pairs: readonly WeightedPair[]): Map<string, string> {
  const adj = new Map<string, Map<string, number>>();
  const link = (x: string, y: string, w: number) => {
    if (!adj.has(x)) adj.set(x, new Map());
    adj.get(x)!.set(y, (adj.get(x)!.get(y) ?? 0) + w);
  };
  for (const { a, b, weight } of pairs) {
    link(a, b, weight);
    link(b, a, weight);
  }
  const nodes = [...adj.keys()].sort();
  const degree = new Map(nodes.map((n) => [n, [...adj.get(n)!.values()].reduce((s, w) => s + w, 0)]));
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
      // ΔQ of joining c, up to a constant: k_in/m − Σtot·k/(2m²), scaled by 2m.
      const gain = (c: string) => 2 * (into.get(c) ?? 0) - (total.get(c)! * k * 2) / m2;
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

/** The projection's identity: unchanged links mean an unchanged answer, so the rebuild is skipped. */
export function graphFingerprint(pairs: readonly WeightedPair[]): string {
  return createHash('sha256')
    .update(pairs.map((p) => `${p.a} ${p.b} ${p.weight}`).join('\n'))
    .digest('hex');
}
