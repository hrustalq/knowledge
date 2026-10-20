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
import type { TemporalPoint } from '../graph/temporal.js';
import { bfs, buildAdjacency, docIdOf, docNode, isDocNode, shortestPath } from '../graph/graph-walk.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import type { AccessScope } from '../permissions/access-scope.js';

/**
 * Phase 4 entity traversal (plan.md §9: find_relations / impact_analysis /
 * trace_relation). Pure application logic over GraphService's workspace-scoped
 * relation graph — BFS runs in Node, mirroring cosine-in-Node search.
 */
@Injectable()
export class EntitiesService {
  constructor(
    private readonly graph: GraphService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The workspace graph as the caller may see it (#76): edges from pages they
   * cannot open go, those pages go, and so does every entity only those pages
   * mention — otherwise a restricted page leaks the names it introduces.
   * GraphService does the pruning; this only supplies the caller's filter.
   * `at` (#81) reads the graph as it stood then, under the same filter.
   */
  private async graphFor(scope: AccessScope, at?: TemporalPoint): Promise<WorkspaceRelationGraph> {
    return this.graph.getWorkspaceRelationGraph(scope.workspaceId, await this.permissions.documentFilterFor(scope), at);
  }

  /**
   * Workspace entities ranked by relation degree. `type` and `q` back the
   * filter autocompletes (e.g. type=tag) so a client picking a tag does not
   * have to pull — and rank — the whole entity roster itself.
   */
  async listEntities(
    scope: AccessScope,
    opts: { type?: string; q?: string; limit?: number } = {},
    at?: TemporalPoint,
  ): Promise<ListEntitiesResponse> {
    const g = await this.graphFor(scope, at);
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

  /**
   * The pages pointing at each of `keys`, over one load of the graph the
   * caller may see — the "affected docs" of an API diff (#78), where a
   * per-key `neighbors` would load the workspace graph once per operation.
   */
  async inboundPages(
    scope: AccessScope,
    keys: string[],
  ): Promise<Map<string, Array<{ documentId: string; title: string; relationType: string; extractor: string }>>> {
    const out = new Map<string, Array<{ documentId: string; title: string; relationType: string; extractor: string }>>();
    if (keys.length === 0) return out;
    const wanted = new Set(keys);
    const g = await this.graphFor(scope);
    for (const e of g.edges) {
      if (!wanted.has(e.targetKey)) continue;
      const list = out.get(e.targetKey) ?? [];
      if (list.some((p) => p.documentId === e.documentId && p.relationType === e.type)) continue;
      list.push({
        documentId: e.documentId,
        title: g.documents[e.documentId]?.title ?? '(unknown)',
        relationType: e.type,
        extractor: e.extractor,
      });
      out.set(e.targetKey, list);
    }
    return out;
  }

  /** Depth-limited neighborhood of an entity (plan.md §9 knowledge.find_relations). */
  async neighbors(
    scope: AccessScope,
    entityKey: string,
    depth = 1,
    relationTypes?: string[],
    at?: TemporalPoint,
  ): Promise<EntityNeighborsResponse> {
    const g = await this.graphFor(scope, at);
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
    scope: AccessScope,
    entityKey: string,
    direction: 'dependents' | 'dependencies' = 'dependents',
    maxDepth = 3,
    at?: TemporalPoint,
  ): Promise<ImpactAnalysisResponse> {
    const g = await this.graphFor(scope, at);
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
    scope: AccessScope,
    fromKey: string,
    toKey: string,
    maxDepth = 4,
    at?: TemporalPoint,
  ): Promise<TraceRelationResponse> {
    const g = await this.graphFor(scope, at);
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
