# 14 — What "ontology" means in Knowledge

**Status:** decided, 2026-11-19

**Issue:** [#1255](https://github.com/hrustalq/knowledge/issues/1255)

**Decision:** **keep the word out of the product.** The graph's typing is
called **entity types** and **relation types**, and there is no "ontology"
page. "Ontology" keeps the one meaning it already ships with: the L1 level of
the `construction` methodology, where a team documents **its own domain**. No
follow-up issue is filed, because no product surface was chosen. The
[reopening criteria](#reopening-criteria) say what would change that.

## The term

The industry uses a spectrum, each step adding structure to the one before:

| Step | Adds | Standard example |
| --- | --- | --- |
| Controlled vocabulary | One agreed list of terms | a tag list |
| Taxonomy | The terms in a hierarchy (broader / narrower) | a category tree |
| Thesaurus | Equivalence (synonyms) and association between terms | SKOS |
| **Ontology** | **Typed classes, typed relations, and constraints**: which relation may join which classes, and how many | OWL; Palantir Foundry object, link and action types; Microsoft Fabric IQ entity and relationship types |
| Knowledge graph | Instances and facts held under that model | |

In practice, "ontology" means the **typed model**: entity types, relation
types and the constraints between them, enforced when something is written.
A list of types with no constraints is a vocabulary or a taxonomy, even when a
product calls it an ontology.

## What we already have

Every step below an ontology exists, under other names:

| Step | Our piece | Where |
| --- | --- | --- |
| Controlled vocabulary, for edges | The closed set of relation types: `RELATION_EDGE_TYPES`, of which `AUTHORABLE_RELATION_TYPES` may be written by hand (`TAGGED_WITH` is synthesised from `tags:`) | `packages/contracts/src/graph/index.ts`; a security boundary, because `GraphService` interpolates the names into SQL |
| Controlled vocabulary, for prose | The glossary: project-scoped terms, aliases, definitions, linked at read time | [feature 14](../features/14-glossary.md) |
| Entity types | The prefix of an entity key: `service:identity` is a `service`. Any non-empty string; a key with no colon is a plain `entity` (`entityTypeOf`) | contracts; `RelationTargetDto.type` is a free string |
| Taxonomy | Five layers derived from the prefix: `system → component → interface → code`, with `concept` for any prefix off the ladder (`ENTITY_LAYER_PREFIXES`, `entityLayerFor`) | [feature 63](../features/63-graph-layers.md). Derived, never stored |
| Thesaurus | `EntityAlias` (`сервис:биллинг` → `service:billing`, one hop, resolved on write), `RELATION_TYPE_ALIASES` (`зависит_от` → `DEPENDS_ON`), glossary aliases | [feature 28](../features/28-relation-management.md), contracts, feature 14 |
| Typed declarations | Component declarations: a page's `component:` block tied to code paths | [feature 51](../features/51-component-pages.md) |
| Knowledge graph | The ArcadeDB graph: `Document → Entity` edges in six fact classes, temporal stamps, communities | [04](04-search-graph.md), features 57 and 63 |

Write-time checks today: the relation type is refused unless it is in the
allowlist, an entity key that reaches the edge writer unfolded throws
(`GraphService.assertCanonicalKey`), and a target must not be empty. **Nothing
checks an entity type.**

## What is missing

Three things stand between this and an ontology.

1. **Entity types belong to no one.** A type is whatever precedes the first
   colon. `ENTITY_LAYER_PREFIXES` is a code catalogue, and it exists only to
   place a prefix on a layer. Types have no registry, no description, no
   Russian label and no owner. So `servce:billing` silently starts a type of
   its own and lands in `concept`. `EntityAlias` can repair one key, not a
   prefix.
2. **Nothing says which relations may join which types.** The graph is
   bipartite: every edge runs page → entity ([04](04-search-graph.md#the-graph-is-bipartite)),
   and the entity-to-entity model of `plan.md` §6 was never built. "A service
   `DEPENDS_ON` a database" is really "a page that `DESCRIBES` a `service:*` key
   `DEPENDS_ON` a `db:*` key". So a domain/range rule can only be stated on the
   page's **subject**, its `DESCRIBES` target. A page may describe several
   entities, or none, and the rule's subject is then ambiguous or missing.
3. **No validation on write beyond the edge type.** If one is added, it has to
   **warn**, not refuse. Frontmatter is the author's text, replayed on every
   reindex, and extraction failures are non-fatal by design. A refused edge
   makes the graph thinner without saying so. That is the failure
   `RELATION_TYPE_ALIASES` was written to end: "the graph looked thin rather
   than broken".

## The decision

**No product surface, and the word stays out of the UI, the help docs and agent
prompts when they mean the graph's typing.** Three reasons:

- **The word already ships with another meaning.** The built-in `construction`
  methodology ([82](../features/82-methodologies.md)) has a level
  **L1 Ontology** / **L1 Онтология**: a collection of `builtin:entity` pages,
  one per domain entity, with "the words in the glossary", worked by the
  `modeller` agent ("Intent, ontology and rules"). There the ontology is
  **documentation of the team's domain**, written as pages. It is not the
  typing of our graph. A Settings page also called "Ontology" would give one
  product two meanings for one word, which is exactly what this issue was
  opened to prevent.
- **A page of types would promise what the code does not do.** Listing entity
  and relation types under the name "ontology" says that a relation is checked
  against the types it joins. Nothing checks that (gap 2), and it cannot be
  checked cleanly on a bipartite graph. The house rules apply: a closed
  vocabulary must not promise a value the code never emits, and a declaration
  is not a fact.
- **Both things people mean by "ontology" are already reachable.**
  - *"Model our domain"* is the `construction` methodology's L1 level, the
    `builtin:entity` template (attributes, states, relations, invariants, and
    a `DESCRIBES` to the entity key) and the glossary.
  - *"Show what the graph knows"* is `GET /v1/entities` (every entity with its
    type and reference count), the per-page graph view
    ([06](../features/06-graph-view.md)) and `knowledge_get_workspace_graph`.

## Vocabulary

Used in the product, the help docs, `GLOSSARY.md` and agent prompts:

| Say | Means | Do not say |
| --- | --- | --- |
| **entity** | A thing the graph knows: one vertex per canonical key | object, node (pages are nodes too), concept (`concept` is a layer) |
| **entity key** | `type:name`, folded by `normalizeEntityKey` | id, slug |
| **entity type** | The key's prefix, `service` in `service:identity` | class, kind (`documents.kind` is openapi / asyncapi), category (a page's category) |
| **relation type** | One of `RELATION_EDGE_TYPES` | link (a connector link maps external content onto a page), predicate, property |
| **layer** | An entity's rung, derived from its type ([63](../features/63-graph-layers.md)) | level (a methodology's stage), tier (a model's size class) |
| **glossary term** | A word of the project's prose vocabulary | entity: a term is linked in text, an entity is a graph vertex |
| **ontology** | Only the `construction` methodology's L1 level: a team's documented domain model | the graph's entity and relation types, schema (Prisma and OpenAPI), taxonomy |

## Reopening criteria

Reopen when one of these holds:

- **Type forks show up in real workspaces.** For example, near-duplicate
  prefixes (`servce` / `service`, `сервис` / `service`) across distinct
  entities in production. This was **not measured** for this record. The
  measurement is one read over `Entity` grouped by type per workspace.
- **A feature needs a relation judged by the types it joins.** For example, a
  drift check or impact analysis that gives a wrong answer unless
  `DEPENDS_ON` is known to run service → database.
- **Entity-to-entity edges get built** (`plan.md` §6). Constraints then become
  direct, and gap 2 goes away.

The follow-up for that day, sketched rather than filed: sparse
`entity_types` rows over `ENTITY_LAYER_PREFIXES` (prefix, en/ru label,
layer, description), a page-level warning for an unregistered prefix in the
style of the component declaration warnings (feature 51), and no refusal. The
page would be named **Entity types**, never Ontology.
