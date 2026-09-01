/**
 * Pure BFS helpers over the workspace relation graph (Phase 4). The graph is
 * bipartite: every stored edge points Document → Entity. Document nodes are
 * addressed as `doc:<documentId>`, entity nodes by their entity key.
 * Used by EntitiesService (neighbors / impact / trace) and SearchService
 * (hybrid graph expansion) — no DB access here.
 */

export interface RelationEdgeRow {
  type: string;
  documentId: string;
  targetKey: string;
  extractor: string;
  confidence: number;
}

export interface AdjacentNode {
  node: string;
  edgeType: string;
  confidence: number;
  /** 'out' = following document → entity; 'in' = the reverse. */
  direction: 'out' | 'in';
}

export const docNode = (documentId: string): string => `doc:${documentId}`;
export const isDocNode = (node: string): boolean => node.startsWith('doc:');
export const docIdOf = (node: string): string => node.slice(4);

export function buildAdjacency(
  edges: RelationEdgeRow[],
  relationTypes?: string[],
): Map<string, AdjacentNode[]> {
  const allowed = relationTypes && relationTypes.length > 0 ? new Set(relationTypes) : null;
  const adj = new Map<string, AdjacentNode[]>();
  const push = (from: string, to: AdjacentNode) => {
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  };
  for (const e of edges) {
    if (allowed && !allowed.has(e.type)) continue;
    const d = docNode(e.documentId);
    push(d, { node: e.targetKey, edgeType: e.type, confidence: e.confidence, direction: 'out' });
    push(e.targetKey, { node: d, edgeType: e.type, confidence: e.confidence, direction: 'in' });
  }
  return adj;
}

export interface BfsHit {
  node: string;
  /** Hops from the start node (documents and entities each count as one hop). */
  hops: number;
  /** Full path from start to this node: [start, ..., node]. */
  path: Array<{ node: string; viaType?: string }>;
}

/** Breadth-first walk up to `maxHops` hops; excludes the start node itself. */
export function bfs(
  adj: Map<string, AdjacentNode[]>,
  start: string,
  maxHops: number,
  follow?: (from: string, edge: AdjacentNode) => boolean,
): BfsHit[] {
  const seen = new Set<string>([start]);
  const out: BfsHit[] = [];
  let frontier: BfsHit[] = [{ node: start, hops: 0, path: [{ node: start }] }];
  for (let hop = 1; hop <= maxHops && frontier.length > 0; hop++) {
    const next: BfsHit[] = [];
    for (const cur of frontier) {
      for (const edge of adj.get(cur.node) ?? []) {
        if (seen.has(edge.node)) continue;
        if (follow && !follow(cur.node, edge)) continue;
        seen.add(edge.node);
        const hit: BfsHit = {
          node: edge.node,
          hops: hop,
          path: [...cur.path, { node: edge.node, viaType: edge.edgeType }],
        };
        out.push(hit);
        next.push(hit);
      }
    }
    frontier = next;
  }
  return out;
}

/** Shortest undirected path between two nodes, or null. */
export function shortestPath(
  adj: Map<string, AdjacentNode[]>,
  from: string,
  to: string,
  maxHops: number,
): Array<{ node: string; viaType?: string }> | null {
  if (from === to) return [{ node: from }];
  for (const hit of bfs(adj, from, maxHops)) {
    if (hit.node === to) return hit.path;
  }
  return null;
}
