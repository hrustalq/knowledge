import type { EntityRef } from '@knowledge/contracts/documents';

// ---------------------------------------------------------------------------

/**
 * Fact classes (plan.md §5), by trust: explicit > frontmatter (deterministic)
 * > curated (user-confirmed) > inferred (LLM). Curated facts are never
 * silently overwritten by automated re-extraction.
 */
export type FactExtractor = 'explicit' | 'frontmatter' | 'inferred' | 'curated';


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
