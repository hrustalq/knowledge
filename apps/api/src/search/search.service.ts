import { Inject, Injectable } from '@nestjs/common';
import type { RelatedDocumentResult, SearchResponse, SearchResult } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { GraphService } from '../graph/graph.service.js';
import { EMBEDDING_PROVIDER, type EmbeddingProvider } from '../embedding/embedding.provider.js';
import type { SearchDto } from './search.dto.js';

@Injectable()
export class SearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
    @Inject(EMBEDDING_PROVIDER) private readonly embeddings: EmbeddingProvider,
  ) {}

  async search(dto: SearchDto): Promise<SearchResponse> {
    const queryEmbedding = await this.embeddings.embed(dto.query);
    const hits = await this.graph.searchChunks(dto.workspaceId, queryEmbedding, dto.limit ?? 20);
    if (hits.length === 0) return { results: [] };

    // Join PG for authoritative titles (three-store separation: PG owns metadata).
    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(hits.map((h) => h.documentId))] } },
      select: { id: true, title: true },
    });
    const titleById = new Map(docs.map((d) => [d.id, d.title]));

    const results: SearchResult[] = hits.map((h) => ({
      documentId: h.documentId,
      revisionId: h.revisionId,
      chunkId: h.chunkId,
      title: titleById.get(h.documentId) ?? '(unknown)',
      snippet: h.text.slice(0, 300),
      score: Number(h.score.toFixed(4)),
    }));

    // Phase 4 hybrid mode: vectors find evidence, the graph expands it
    // (plan.md §12.7). Walk relation edges out from the hit documents.
    if ((dto.mode ?? 'hybrid') === 'hybrid' && dto.expandGraph) {
      const related = await this.expandGraph(
        dto.workspaceId,
        results,
        Math.min(dto.expandGraph.depth ?? 1, 3),
        dto.expandGraph.relationTypes,
      );
      return { results, related };
    }
    return { results };
  }

  /**
   * BFS from the hit documents over the doc→entity relation graph. Attaches
   * each hit document's entities to its results and returns documents that are
   * only reachable through the graph, with the connecting edges as evidence.
   */
  private async expandGraph(
    workspaceId: string,
    results: SearchResult[],
    depth: number,
    relationTypes?: string[],
  ): Promise<RelatedDocumentResult[]> {
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
    const allowed = relationTypes?.length ? new Set(relationTypes) : null;
    const edges = allowed ? g.edges.filter((e) => allowed.has(e.type)) : g.edges;

    const entitiesByDoc = new Map<string, typeof edges>();
    const docsByEntity = new Map<string, typeof edges>();
    for (const e of edges) {
      entitiesByDoc.set(e.documentId, [...(entitiesByDoc.get(e.documentId) ?? []), e]);
      docsByEntity.set(e.targetKey, [...(docsByEntity.get(e.targetKey) ?? []), e]);
    }

    const hitDocIds = new Set(results.map((r) => r.documentId));
    for (const r of results) {
      const rels = entitiesByDoc.get(r.documentId);
      if (rels?.length) {
        r.entities = [...new Set(rels.map((e) => e.targetKey))].map((key) => ({
          key,
          type: g.entities[key]?.type ?? 'entity',
          name: g.entities[key]?.name ?? key,
        }));
      }
    }

    // depth = entity hops: docs sharing an entity with a hit are distance 1.
    const related = new Map<string, RelatedDocumentResult>();
    let frontierDocs = new Set(hitDocIds);
    const seenDocs = new Set(hitDocIds);
    for (let hop = 1; hop <= depth; hop++) {
      const nextDocs = new Set<string>();
      for (const docId of frontierDocs) {
        for (const out of entitiesByDoc.get(docId) ?? []) {
          for (const inc of docsByEntity.get(out.targetKey) ?? []) {
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
    return [...related.values()].sort((a, b) => a.distance - b.distance || b.via.length - a.via.length);
  }
}
