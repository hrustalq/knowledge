import type { EntityRef } from '@knowledge/contracts/documents';

// ---------------------------------------------------------------------------

/**
 * Fact classes (plan.md §5), by trust: explicit > frontmatter (deterministic)
 * > curated (user-confirmed) > inferred (LLM). Curated facts are never
 * silently overwritten by automated re-extraction.
 */
export type FactExtractor = 'explicit' | 'frontmatter' | 'inferred' | 'curated';

/**
 * Relation edge types allowed in the graph (plan.md §6).
 *
 * This lives here rather than beside the graph service because seven consumers
 * have to agree on it and, until this moved, did not: the SQL allowlist carried
 * eight types, the frontmatter parser and the DTO seven, and the workflow canvas
 * five — so a chain could name an edge type the graph would refuse, and the
 * architect silently rewrote anything it did not recognise to IMPLEMENTS.
 *
 * Edge type names are interpolated into SQL by `GraphService`, so this list is a
 * security boundary: `assertEdgeType` must keep importing it rather than
 * carrying a copy. Shared here, forked nowhere.
 */
export const RELATION_EDGE_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
  'TAGGED_WITH',
] as const;
export type RelationEdgeType = (typeof RELATION_EDGE_TYPES)[number];

/**
 * The types a person or a model may write by hand — in frontmatter `relations:`,
 * through the relations API, or as a workflow's `relationToParent`.
 *
 * TAGGED_WITH is deliberately absent: a tag edge is *synthesised* from the
 * `tags:` key by the deterministic extractor, so accepting it here would give
 * tags two spellings that behave differently. `normalizeRelation` already
 * rejects it; this constant is why.
 */
export const AUTHORABLE_RELATION_TYPES = [
  'DESCRIBES',
  'DEPENDS_ON',
  'IMPLEMENTS',
  'RELATED_TO',
  'OWNED_BY',
  'SUPERSEDES',
  'CONTRADICTS',
] as const;
export type AuthorableRelationType = (typeof AUTHORABLE_RELATION_TYPES)[number];

export function isAuthorableRelationType(value: string): value is AuthorableRelationType {
  return (AUTHORABLE_RELATION_TYPES as readonly string[]).includes(value);
}


export interface EntitySummary {
  key: string;
  type: string;
  name: string;
  /** Number of relation edges touching this entity in the workspace. */
  degree: number;
}

// GET /v1/entities?workspaceId=
export interface ListEntitiesResponse {
  entities: EntitySummary[];
}

export interface EntityRelationEdge {
  documentId: string;
  documentTitle: string;
  entityKey: string;
  relationType: string;
  extractor: FactExtractor | string;
  confidence: number;
  /** 'out' = document → entity (all stored edges point that way). */
  direction: 'out';
}

// GET /v1/entities/:key/neighbors (plan.md §9 knowledge.find_relations)
export interface EntityNeighborsResponse {
  entity: EntityRef;
  /** Edges touching the entity (depth 1). */
  edges: EntityRelationEdge[];
  /** Entities reachable within `depth` hops via shared documents. */
  relatedEntities: Array<EntityRef & { distance: number }>;
}

export interface ImpactPathStep {
  kind: 'entity' | 'document';
  id: string;
  label: string;
  /** Edge type that led here (absent on the starting node). */
  viaType?: string;
}
export interface ImpactedNode {
  entity: EntityRef;
  distance: number;
  path: ImpactPathStep[];
}
export interface ImpactAnalysisResponse {
  entity: EntityRef;
  direction: 'dependents' | 'dependencies';
  impactedEntities: ImpactedNode[];
  /** Documents on any impact path. */
  affectedDocuments: Array<{ documentId: string; title: string; distance: number }>;
}

// GET /v1/entities/trace?workspaceId&from&to (plan.md §9 knowledge.trace_relation)
export interface TraceRelationResponse {
  from: string;
  to: string;
  /** Alternating entity/document steps, or null when no path exists. */
  path: ImpactPathStep[] | null;
  hops: number | null;
}

// ---------------------------------------------------------------------------
// Phase 5 — governance & scale: auth/ACLs, audited operator queries,
