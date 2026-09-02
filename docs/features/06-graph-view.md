# 06 — Document graph view

> Оригинал: «Просмотр графа документа (зависимости и связанные сущности)»

## What it is

A **Graph** tab on the document page visualizing the document's neighbourhood
in the knowledge graph: its entities, and other documents connected through
them.

## Design

- **API**: `GET /v1/documents/:id/graph?depth=<1..3>` →
  `DocumentGraphResponse { nodes, edges }` where nodes are
  `{ id, kind: 'document' | 'entity', label, category? }` and edges carry
  `{ from, to, type, confidence, extractor }`. Implemented in
  `DocumentsService.getDocumentGraph` over
  `GraphService.getWorkspaceRelationGraph` + the pure BFS helpers in
  `graph-walk.ts` (`depth` = entity hops; one entity hop = two BFS hops, same
  convention as Phase 4 traversal). The workspace predicate is enforced by
  `GraphService` as always.
- **Web**: `GraphView.vue` — dependency-free SVG rendering with a small
  precomputed force layout (repulsion + edge springs, fixed iteration count,
  center-pinned root). Documents are rectangles (click → navigate), entities
  are circles, edge labels show the relation type; extractor class is encoded
  in edge style (solid = explicit/curated/frontmatter, dashed = inferred).

## Future work

- Zoom/pan and neighbourhood expansion on click.
- Workspace-wide graph explorer page (same component, entity as root).
