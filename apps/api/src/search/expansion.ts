import type { RelatedDocumentResult } from '@knowledge/contracts';
import { entityLayerFor, layerRung, pageLayerOf } from '@knowledge/contracts';
import { HUB_ENTITY_PAGES } from '../agents/communities.js';
import type { WorkspaceRelationGraph } from '../graph/graph.service.js';

type Edges = WorkspaceRelationGraph['edges'];

/**
 * Hybrid search's graph expansion, Nest-free: BFS from the hit pages over the
 * page → entity graph. `depth` counts entity hops, so a page sharing an entity
 * with a hit is distance 1. `follow` says which of a page's entities a hop may
 * cross — every one (`flatFollow`, the walk before #475) or the layered rule.
 */
export function walkRelated(
  g: Pick<WorkspaceRelationGraph, 'edges' | 'documents'>,
  hitDocIds: ReadonlySet<string>,
  depth: number,
  follow: (docId: string) => Iterable<string>,
): RelatedDocumentResult[] {
  const docsByEntity = edgesByEntity(g.edges);
  const related = new Map<string, RelatedDocumentResult>();
  let frontierDocs = new Set(hitDocIds);
  const seenDocs = new Set(hitDocIds);
  for (let hop = 1; hop <= depth; hop++) {
    const nextDocs = new Set<string>();
    for (const docId of frontierDocs) {
      for (const key of follow(docId)) {
        for (const inc of docsByEntity.get(key) ?? []) {
          if (seenDocs.has(inc.documentId)) {
            const existing = related.get(inc.documentId);
            if (existing && existing.distance === hop) {
              if (!existing.via.some((v) => v.entityKey === inc.targetKey && v.relationType === inc.type)) {
                existing.via.push({ entityKey: inc.targetKey, relationType: inc.type, confidence: inc.confidence });
              }
            }
            continue;
          }
          seenDocs.add(inc.documentId);
          nextDocs.add(inc.documentId);
          related.set(inc.documentId, {
            documentId: inc.documentId,
            title: g.documents[inc.documentId]?.title ?? '(unknown)',
            distance: hop,
            via: [{ entityKey: inc.targetKey, relationType: inc.type, confidence: inc.confidence }],
          });
        }
      }
    }
    frontierDocs = nextDocs;
  }
  return [...related.values()];
}

/** Every entity a page names: the walk as it was before #475. */
export function flatFollow(edges: Edges): (docId: string) => string[] {
  const keys = keysByDoc(edges);
  return (docId) => keys.get(docId) ?? [];
}

/**
 * The layered rule (#475, docs/features/63). From a page on rung ℓ, a hop
 * crosses its entities on rungs ℓ−1…ℓ+1, the membership parents and children
 * of its rung-ℓ entities on those rungs, and its `concept` entities whatever
 * ℓ is. A `concept` page crosses every rung. An entity more than
 * HUB_ENTITY_PAGES pages name is crossed at no layer.
 */
export function layeredFollow(edges: Edges, parents: ReadonlyMap<string, ReadonlySet<string>>): (docId: string) => string[] {
  const keys = keysByDoc(edges);
  const pagesOf = new Map([...edgesByEntity(edges)].map(([key, es]) => [key, new Set(es.map((e) => e.documentId)).size]));
  const children = new Map<string, Set<string>>();
  for (const [child, ps] of parents) for (const p of ps) children.set(p, (children.get(p) ?? new Set()).add(child));

  return (docId) => {
    const own = keys.get(docId) ?? [];
    const layer = pageLayerOf(own);
    const rung = layer ? layerRung(layer) : null;
    const inBand = (key: string) => {
      const r = layerRung(entityLayerFor(key));
      return r === null || rung === null || Math.abs(r - rung) <= 1;
    };
    const out = new Set(own.filter(inBand));
    for (const key of own) {
      if (rung === null || layerRung(entityLayerFor(key)) !== rung) continue;
      for (const k of [...(parents.get(key) ?? []), ...(children.get(key) ?? [])]) if (inBand(k)) out.add(k);
    }
    return [...out].filter((key) => (pagesOf.get(key) ?? 0) <= HUB_ENTITY_PAGES);
  };
}

function keysByDoc(edges: Edges): Map<string, string[]> {
  const keys = new Map<string, Set<string>>();
  for (const e of edges) keys.set(e.documentId, (keys.get(e.documentId) ?? new Set()).add(e.targetKey));
  return new Map([...keys].map(([doc, ks]) => [doc, [...ks]]));
}

function edgesByEntity(edges: Edges): Map<string, Edges> {
  const byEntity = new Map<string, Edges>();
  for (const e of edges) byEntity.set(e.targetKey, [...(byEntity.get(e.targetKey) ?? []), e]);
  return byEntity;
}
