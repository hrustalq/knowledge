import type { EntityRef } from '@knowledge/contracts/documents';

// ---------------------------------------------------------------------------

/**
 * Fact classes (plan.md §5), by trust: explicit > frontmatter (deterministic)
 * > curated (user-confirmed) > inferred (LLM). Curated facts are never
 * silently overwritten by automated re-extraction.
 *
 * `code` (#236) is derived from a codebase connector's import index: a page
 * documenting a file that imports a declared component `DEPENDS_ON` it. No
 * author writes one — every pull replaces them — so no input path accepts it.
 *
 * `spec` (#78) is an API spec document's `DESCRIBES` edge to each operation or
 * channel it defines. Deterministic like frontmatter and revision-scoped like
 * it, so a branch revision's operations stay out of the live graph until it
 * merges; its own class so the frontmatter replace never wipes it.
 */
export type FactExtractor = 'explicit' | 'frontmatter' | 'inferred' | 'curated' | 'code' | 'spec';

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

// --- canonical spelling -----------------------------------------------------

/**
 * Relation types as a bilingual team actually writes them.
 *
 * The workspace is ru + en (docs/features/18) and the edge vocabulary is
 * English uppercase, so a Russian author had exactly one way to declare a
 * relation: in a language their page is not written in. Anything else was
 * dropped by `isAuthorableRelationType` with no log line, which is why the
 * graph looked thin rather than broken.
 *
 * Keys are the NFC-uppercased form `normalizeRelationType` produces, so the
 * lookup happens after folding rather than needing a case variant per entry.
 * This is a closed catalogue in contracts for the usual reason: the frontmatter
 * parser, the inferred extractor and the relations DTO must agree on it.
 */
export const RELATION_TYPE_ALIASES: Readonly<Record<string, AuthorableRelationType>> = {
  ОПИСЫВАЕТ: 'DESCRIBES',
  ОПИСАНИЕ: 'DESCRIBES',
  ЗАВИСИТ_ОТ: 'DEPENDS_ON',
  ЗАВИСИМОСТЬ: 'DEPENDS_ON',
  РЕАЛИЗУЕТ: 'IMPLEMENTS',
  РЕАЛИЗАЦИЯ: 'IMPLEMENTS',
  СВЯЗАНО_С: 'RELATED_TO',
  СВЯЗАН_С: 'RELATED_TO',
  СВЯЗАНО: 'RELATED_TO',
  ПРИНАДЛЕЖИТ: 'OWNED_BY',
  ВЛАДЕЛЕЦ: 'OWNED_BY',
  ЗАМЕНЯЕТ: 'SUPERSEDES',
  УСТАРЕЛО: 'SUPERSEDES',
  ПРОТИВОРЕЧИТ: 'CONTRADICTS',
};

/**
 * The frontmatter keys the deterministic extractor recognises.
 *
 * Same reasoning as the type aliases: `связи:` on a Russian page used to yield
 * zero edges, silently. Longest/exact match only — these are whole keys, not
 * prefixes.
 */
export const FRONTMATTER_KEY_ALIASES: Readonly<Record<string, 'relations' | 'tags'>> = {
  relations: 'relations',
  связи: 'relations',
  отношения: 'relations',
  tags: 'tags',
  теги: 'tags',
  метки: 'tags',
};

/** Trim, case-fold, and collapse inner whitespace into the kebab the keys use. */
function fold(part: string): string {
  return part.trim().toLowerCase().replace(/\s+/gu, '-');
}

/**
 * The canonical spelling of an entity key — the graph's identity for a concept.
 *
 * `Entity` uniques on `(workspaceId, entityKey)` with plain string equality, so
 * before this existed `service:Billing`, `service: billing` and a macOS-composed
 * `Сервис:Биллинг` were three vertices for one thing, and the ru and en pages
 * about it never linked up. Unicode normalization is not optional here: NFC vs
 * NFD `й` is invisible on screen and fatal to an equality index.
 *
 * Splits on the FIRST colon so a key may carry more (`service:eu:billing`), and
 * folds each side. Display text is deliberately NOT folded — the caller keeps
 * the author's casing in `name` so the graph view stays legible.
 */
export function normalizeEntityKey(raw: string): string {
  const nfc = raw.normalize('NFC');
  const colon = nfc.indexOf(':');
  if (colon === -1) return fold(nfc);
  const type = fold(nfc.slice(0, colon));
  let rest = nfc.slice(colon + 1);
  // #78: an API operation or channel is one entity however its path
  // parameters are named, so `/users/{id}` and `/users/{userId}` fold here —
  // in the one function every writer calls — rather than only where a spec is
  // parsed. A page's frontmatter naming the operation then lands on the same
  // vertex the spec wrote.
  if (type === 'op' || type === 'channel') rest = rest.replace(/\{[^}]*\}/gu, '{}');
  return `${type}:${fold(rest)}`;
}

/** `service:identity` → `service`; a bare key is a plain entity. */
export function entityTypeOf(key: string): string {
  return key.includes(':') ? key.slice(0, key.indexOf(':')) : 'entity';
}

/** `service:identity` → `identity`, so a vertex stays legible in the graph view. */
export function entityNameOf(key: string): string {
  return key.split(':').pop() ?? key;
}

/**
 * One relation type, or null when it is not one.
 *
 * Accepts `depends_on`, `DEPENDS ON`, `depends-on` and `зависит_от` alike. The
 * two fact classes used to disagree about this — the inferred extractor
 * uppercased what the model returned while the frontmatter parser demanded the
 * exact constant — so the same spelling was valid from a model and invalid from
 * a person. One function now, both callers.
 */
export function normalizeRelationType(raw: string): AuthorableRelationType | null {
  const folded = raw.normalize('NFC').trim().toUpperCase().replace(/[\s-]+/gu, '_');
  if (isAuthorableRelationType(folded)) return folded;
  return RELATION_TYPE_ALIASES[folded] ?? null;
}


// --- abstraction layers (#475) -----------------------------------------------

/**
 * Where an entity sits, coarsest to finest, plus `concept` for everything off
 * that ladder (docs/features/63). Derived from the key, never stored: a layer
 * on the vertex would be a second answer to what the key already says.
 */
export const ENTITY_LAYERS = ['system', 'component', 'interface', 'code', 'concept'] as const;
export type EntityLayer = (typeof ENTITY_LAYERS)[number];

/**
 * The type prefixes of each rung. Whole segments (`entityTypeOf`), matched
 * exactly. A closed catalogue: a prefix not here is `concept`, and adding one
 * is a contracts change with a spec case. `concept` has no list — its inverse
 * is "none of these".
 */
export const ENTITY_LAYER_PREFIXES: Readonly<Record<Exclude<EntityLayer, 'concept'>, readonly string[]>> = {
  system: ['system', 'service', 'domain', 'product', 'platform', 'integration'],
  component: ['component', 'library', 'db', 'database', 'table', 'index', 'cache', 'queue', 'topic'],
  interface: ['op', 'channel', 'spec', 'api', 'endpoint', 'event'],
  code: ['module', 'file', 'symbol', 'function', 'class', 'task'],
};

const LAYER_OF_PREFIX: ReadonlyMap<string, EntityLayer> = new Map(
  Object.entries(ENTITY_LAYER_PREFIXES).flatMap(([layer, prefixes]) => prefixes.map((p) => [p, layer as EntityLayer] as const)),
);

/** `op:post /invoices/{}` → `interface`; an unknown prefix or a bare key → `concept`. */
export function entityLayerFor(key: string): EntityLayer {
  return LAYER_OF_PREFIX.get(entityTypeOf(key)) ?? 'concept';
}

/**
 * The inverse, for a read that filters by layer: the type prefixes of a rung.
 * `concept` returns null — it is every prefix NOT listed, so filter with
 * `NOT IN (all listed prefixes)` instead.
 */
export function entityTypesOfLayer(layer: EntityLayer): readonly string[] | null {
  return layer === 'concept' ? null : ENTITY_LAYER_PREFIXES[layer];
}

/** A rung's position on the ladder (0 = system), or null for `concept`. */
export function layerRung(layer: EntityLayer): number | null {
  return layer === 'concept' ? null : ENTITY_LAYERS.indexOf(layer);
}

/**
 * A page's layer: the rung holding most of its distinct entities, a tie to
 * the finer rung — so a page naming one operation and its service is an
 * `interface` page. All-`concept` is `concept`; no entities, no layer.
 */
export function pageLayerOf(keys: Iterable<string>): EntityLayer | null {
  const counts = new Map<EntityLayer, number>();
  for (const key of new Set(keys)) {
    const layer = entityLayerFor(key);
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: EntityLayer | null = null;
  // Coarse to fine, so `>=` hands a tie to the finer rung.
  for (const layer of ENTITY_LAYERS.slice(0, 4)) {
    const n = counts.get(layer) ?? 0;
    if (n > 0 && n >= (best ? counts.get(best)! : 0)) best = layer;
  }
  return best ?? 'concept';
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
  /** Present when read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
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
  /** Present when read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
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
  /** Present when read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
  entity: EntityRef;
  direction: 'dependents' | 'dependencies';
  impactedEntities: ImpactedNode[];
  /** Documents on any impact path. */
  affectedDocuments: Array<{ documentId: string; title: string; distance: number }>;
}

// GET /v1/entities/trace?workspaceId&from&to (plan.md §9 knowledge.trace_relation)
export interface TraceRelationResponse {
  /** Present when read as of a point in time (#81). */
  resolvedAsOf?: ResolvedAsOf;
  from: string;
  to: string;
  /** Alternating entity/document steps, or null when no path exists. */
  path: ImpactPathStep[] | null;
  hops: number | null;
}

// ---------------------------------------------------------------------------
// Phase 5 — governance & scale: auth/ACLs, audited operator queries,

// ---------------------------------------------------------------------------
// Bi-temporal graph (#81)

/**
 * How an `asOf` was given: an ISO date, `rev:<uuid>` (that revision's
 * finalize time), `tag:<name>` (a release tag's instant), or `now` — only
 * `knownAt` was given, so the valid-time point is the present.
 */
export const AS_OF_KINDS = ['date', 'revision', 'tag', 'now'] as const;
export type AsOfKind = (typeof AS_OF_KINDS)[number];

/** What an `asOf`/`knownAt` pair resolved to — echoed so a UI shows what applied. */
export interface ResolvedAsOf {
  kind: AsOfKind;
  /** The value as given (`2026-05-01`, `rev:…`, `tag:v2.3`), or `now`. */
  ref: string;
  /** The valid-time instant the read used, ISO. A future date clamps to now. */
  at: string;
  /** The system-time instant (what was believed then), ISO; null = now. */
  knownAt: string | null;
}

/** A release tag's name: letters, digits and `. _ - /`, at most 64. */
export const RELEASE_TAG_NAME_PATTERN = '^[A-Za-z0-9._\\-/]{1,64}$';

/** A named instant on the valid-time axis ("v2.3", "Q3 audit"). Not a git tag. */
export interface ReleaseTagDto {
  id: string;
  workspaceId: string;
  /** null = the whole workspace. */
  projectId: string | null;
  name: string;
  at: string;
  note: string | null;
  createdBy: string;
  createdAt: string;
}

// GET /v1/release-tags?workspaceId=&projectId=
export interface ListReleaseTagsResponse {
  tags: ReleaseTagDto[];
}

/** One day of fact changes: how many facts became valid, and how many stopped. */
export interface GraphTimelineDay {
  /** YYYY-MM-DD, UTC. */
  day: string;
  opened: number;
  closed: number;
}

// GET /v1/graph/timeline?workspaceId=&projectId=&from=&to=
export interface GraphTimelineResponse {
  workspaceId: string;
  projectId: string | null;
  from: string;
  to: string;
  /** Tags in the window, oldest first: the labelled ticks of the slider. */
  tags: ReleaseTagDto[];
  /** Days with at least one change, oldest first: the density sparkline. */
  days: GraphTimelineDay[];
}

// ---------------------------------------------------------------------------
// Knowledge conflicts (#81)

/** What disagrees with what: two pages (the arbiter), or a page and a code change (the sentinel). */
export const CONFLICT_KINDS = ['doc-doc', 'doc-code'] as const;
export type ConflictKind = (typeof CONFLICT_KINDS)[number];

/**
 * `open` until a person acts or the text goes away: `resolved` (fixed, or not
 * a conflict after all with a note), `dismissed` (wrong; stays dismissed when
 * re-detected), `superseded` (a side's page changed, so the quoted text is no
 * longer current — reopened if the new text still conflicts).
 */
export const CONFLICT_STATUSES = ['open', 'resolved', 'dismissed', 'superseded'] as const;
export type ConflictStatus = (typeof CONFLICT_STATUSES)[number];

/** One side of a conflict: the page, the revision the quote was read from, and the quote. */
export interface ConflictSide {
  documentId: string;
  title: string;
  revisionId: string;
  chunkId: string | null;
  quote: string;
}

/** The code side of a doc↔code conflict: the pull request the sentinel judged. */
export interface ConflictCodeRef {
  connectorId: string;
  repository: string;
  pullRequestNumber: number;
  pullRequestUrl: string;
  headSha: string;
  /** Files the change touches, as the sentinel saw them; may be capped. */
  paths: string[];
}

/** A contradiction between two pages, or a page and code (#81). A proposal, never a change. */
export interface KnowledgeConflictDto {
  id: string;
  workspaceId: string;
  kind: ConflictKind;
  status: ConflictStatus;
  a: ConflictSide;
  /** The other page; null on a doc↔code conflict, which has `codeRef` instead. */
  b: ConflictSide | null;
  codeRef: ConflictCodeRef | null;
  explanation: string;
  confidence: number;
  /** The arbiter run that found it, and the merge request a fix was proposed as. */
  agentRunId: string | null;
  mergeRequestId: string | null;
  detectedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: string | null;
}

// GET /v1/conflicts?workspaceId=&status=&kind=&documentId=
export interface ListConflictsResponse {
  conflicts: KnowledgeConflictDto[];
}

// ---------------------------------------------------------------------------
// Communities (#81, phase 7)

/** One community of pages and what they are about, for global questions. */
export interface CommunitySummaryDto {
  communityId: string;
  /** 0 = finest; each level above merges communities of the levels below (#475). */
  level: number;
  /** The community this one merged into; null for a root. */
  parentId: string | null;
  title: string;
  /** Written by the atlas agent from the member pages; a summary, not a source. */
  summary: string;
  documents: Array<{ documentId: string; title: string }>;
  builtAt: string;
  /** Closeness to the question asked, 0..1; 0 when none was. */
  score: number;
}

// GET /v1/graph/communities?workspaceId=&q=&limit=&level=
export interface ListCommunitiesResponse {
  communities: CommunitySummaryDto[];
}
