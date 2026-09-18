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

## Update — a materialized path, and an AI that can see it

Two things listed above as design consequences turned out to be defects.

**The tree existed only as `parent_id`.** Every traversal was a walk or a scan:
`getAncestors` made up to 32 sequential queries, `descendantIds` loaded every document in
the workspace and BFS'd them in Node, and the cycle check on move climbed the chain one
`findUnique` at a time. `documents` now carries `path` (`/rootId/…/selfId/`), `depth` and
`position`, backfilled in `20260918084445_documents_materialized_path` with a recursive CTE
that seeds from rows whose parent is missing as well as from real roots — there is no FK on
`parent_id`, so orphans must seed or their subtrees get no path at all.

What that buys, in the same commit rather than as follow-ups:

- the cycle check is `parent.path.includes('/' + documentId + '/')` — one indexed read, no
  walk, and the hop bound and `seen` set are gone because a string comparison cannot spin;
- `descendantIds` is a prefix match on an index instead of a workspace scan;
- a breadcrumb costs no walk at all: the ancestor ids are already in the path, so
  `breadcrumbsFor` is two queries for any number of pages;
- a move shifts the whole subtree in one statement, **inside** the transaction that updates
  the row — the subtree re-project used to sit outside any explicit boundary, so a failure
  between the two left children in a project their parent had already left;
- ordering is `position, title`, backfilled from the title order the tree was drawn in, so
  the migration changes nothing on screen and manual reordering becomes possible.

**"Nesting does not affect the graph" was read as "nesting does not affect the AI".** It
should never have followed. The model could browse a connected git repository's directory
tree with `code_tree` and had nothing for the knowledge base's own; `create_document` asked
for a `parentId` UUID it had no tool to discover; so every AI-authored page landed at the
top level of whichever project was oldest. There is now a `list_document_tree` read tool,
`read_document` and `search_knowledge` results carry a breadcrumb, and `PAGE_PLACEMENT_RULE`
tells the model to look before it places.

The graph is still untouched — no `PART_OF` edge, and `EMBED_RECIPE` is unchanged, so none
of this re-embeds the corpus. Hierarchy reaches the model as **context**, not as semantics,
which is the distinction the original decision was actually drawing.
