import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  EntityNeighborsResponse,
  EntityRef,
  ImpactAnalysisResponse,
  ImpactPathStep,
  ListEntitiesResponse,
  TraceRelationResponse,
} from '@knowledge/contracts';
import { GraphService, type WorkspaceRelationGraph } from '../graph/graph.service.js';
import { bfs, buildAdjacency, docIdOf, docNode, isDocNode, shortestPath } from '../graph/graph-walk.js';
import { t } from '../i18n/t.js';

/**
 * Phase 4 entity traversal (plan.md §9: find_relations / impact_analysis /
 * trace_relation). Pure application logic over GraphService's workspace-scoped
 * relation graph — BFS runs in Node, mirroring cosine-in-Node search.
 */
@Injectable()
export class EntitiesService {
  constructor(private readonly graph: GraphService) {}

  /**
   * Workspace entities ranked by relation degree. `type` and `q` back the
   * filter autocompletes (e.g. type=tag) so a client picking a tag does not
   * have to pull — and rank — the whole entity roster itself.
   */
  async listEntities(
    workspaceId: string,
    opts: { type?: string; q?: string; limit?: number } = {},
  ): Promise<ListEntitiesResponse> {
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
    const degree = new Map<string, number>();
    for (const e of g.edges) degree.set(e.targetKey, (degree.get(e.targetKey) ?? 0) + 1);

    const needle = opts.q?.trim().toLowerCase();
    let entities = Object.entries(g.entities)
      .map(([key, e]) => ({ key, type: e.type, name: e.name, degree: degree.get(key) ?? 0 }))
      .filter((e) => !opts.type || e.type === opts.type)
      .filter((e) => !needle || e.name.toLowerCase().includes(needle))
      .sort((a, b) => b.degree - a.degree || a.key.localeCompare(b.key));

    if (opts.limit !== undefined) entities = entities.slice(0, opts.limit);
    return { entities };
  }

  /** Depth-limited neighborhood of an entity (plan.md §9 knowledge.find_relations). */
  async neighbors(
    workspaceId: string,
    entityKey: string,
    depth = 1,
    relationTypes?: string[],
  ): Promise<EntityNeighborsResponse> {
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
    const entity = this.entityRef(g, entityKey);
    const adj = buildAdjacency(g.edges, relationTypes);

    const edges = g.edges
      .filter((e) => e.targetKey === entityKey && (!relationTypes?.length || relationTypes.includes(e.type)))
      .map((e) => ({
        documentId: e.documentId,
        documentTitle: g.documents[e.documentId]?.title ?? '(unknown)',
        entityKey: e.targetKey,
        relationType: e.type,
        extractor: e.extractor,
        confidence: e.confidence,
        direction: 'out' as const,
      }));

    // Entity hops: each doc→entity pair is 2 BFS hops.
    const related = bfs(adj, entityKey, Math.min(Math.max(depth, 1), 3) * 2)
      .filter((h) => !isDocNode(h.node))
      .map((h) => ({ ...this.entityRef(g, h.node), distance: h.hops / 2 }));

    return { entity, edges, relatedEntities: related };
  }

  /**
   * Impact analysis over the bipartite doc→entity graph (plan.md §9).
   * DESCRIBES ties a document to its subject entity; every other edge type is
   * a reference.
   *  - dependents: docs referencing the entity are impacted; the entities those
   *    docs DESCRIBE are transitively impacted.
   *  - dependencies: docs DESCRIBING the entity carry its implementation; the
   *    entities they reference are its dependencies.
   */
  async impactAnalysis(
    workspaceId: string,
    entityKey: string,
    direction: 'dependents' | 'dependencies' = 'dependents',
    maxDepth = 3,
  ): Promise<ImpactAnalysisResponse> {
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
    const entity = this.entityRef(g, entityKey);
    const adj = buildAdjacency(g.edges);

    // direction-aware edge filter:
    // dependents:   entity --(in, any-but-DESCRIBES)--> doc --(out, DESCRIBES)--> entity
    // dependencies: entity --(in, DESCRIBES)--> doc --(out, any-but-DESCRIBES)--> entity
    const follow = (from: string, edge: { edgeType: string }): boolean => {
      const fromEntity = !isDocNode(from);
      const describes = edge.edgeType === 'DESCRIBES';
      if (direction === 'dependents') return fromEntity ? !describes : describes;
      return fromEntity ? describes : !describes;
    };

    const hits = bfs(adj, entityKey, Math.min(Math.max(maxDepth, 1), 5) * 2, follow);
    const impactedEntities = hits
      .filter((h) => !isDocNode(h.node))
      .map((h) => ({
        entity: this.entityRef(g, h.node),
        distance: h.hops / 2,
        path: h.path.map((p) => this.pathStep(g, p)),
      }));
    const affectedDocuments = hits
      .filter((h) => isDocNode(h.node))
      .map((h) => ({
        documentId: docIdOf(h.node),
        title: g.documents[docIdOf(h.node)]?.title ?? '(unknown)',
        distance: Math.ceil(h.hops / 2),
      }));

    return { entity, direction, impactedEntities, affectedDocuments };
  }

  /** Shortest relation path between two entities (plan.md §9 knowledge.trace_relation). */
  async trace(
    workspaceId: string,
    fromKey: string,
    toKey: string,
    maxDepth = 4,
  ): Promise<TraceRelationResponse> {
    const g = await this.graph.getWorkspaceRelationGraph(workspaceId);
    this.entityRef(g, fromKey);
    this.entityRef(g, toKey);
    const adj = buildAdjacency(g.edges);
    const path = shortestPath(adj, fromKey, toKey, Math.min(Math.max(maxDepth, 1), 6) * 2);
    return {
      from: fromKey,
      to: toKey,
      path: path ? path.map((p) => this.pathStep(g, p)) : null,
      hops: path ? (path.length - 1) / 2 : null,
    };
  }

  private pathStep(g: WorkspaceRelationGraph, p: { node: string; viaType?: string }): ImpactPathStep {
    if (isDocNode(p.node)) {
      const id = docIdOf(p.node);
      return { kind: 'document', id, label: g.documents[id]?.title ?? '(unknown)', viaType: p.viaType };
    }
    return { kind: 'entity', id: p.node, label: g.entities[p.node]?.name ?? p.node, viaType: p.viaType };
  }

  private entityRef(g: WorkspaceRelationGraph, key: string): EntityRef {
    const e = g.entities[key];
    if (!e) throw new NotFoundException(t('error.entity.notFound', { key }));
    return { key, type: e.type, name: e.name };
  }
}
