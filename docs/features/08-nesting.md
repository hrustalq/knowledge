# 08 — Document nesting (directories)

> Оригинал: «Вложенность документов, как в confluence (с директориями)»

## What it is

Confluence-style hierarchy: any document can have a parent document; the
documents page shows the tree.

## Design

- **DB**: `documents.parent_id` — nullable self-reference (no FK cascade
  delete; children are re-rooted rather than dropped). Indexed.
- **API**:
  - `POST /v1/documents` accepts `parentId` (must be in the same workspace);
  - `PATCH /v1/documents/:id` moves a document (`parentId: null` re-roots).
    Cycle protection: walking up from the new parent must not reach the
    document being moved;
  - `GET /v1/documents/tree?workspaceId=` →
    `DocumentTreeResponse { roots: DocumentTreeNode[] }`, each node =
    `DocumentSummary & { children: DocumentTreeNode[] }`, built in one query +
    in-memory assembly, ordered by title. Documents whose parent is missing
    (deleted/legacy) surface as roots — nothing is ever hidden.
- **Web**: the documents page renders the tree with expand/collapse
  (`DocumentTreeNode.vue`, recursive), status + category badges per row.
  Upload/editor expose a parent picker.

## Notes

- Nesting is organizational only — it does not affect search ranking or the
  graph. A `PART_OF` graph edge was deliberately not auto-created; the graph
  models semantic facts, not UI structure.

## Future work

- Ordering within a folder (manual sort keys).
- Breadcrumbs on the document page; move-by-drag in the tree.
