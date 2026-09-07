# 11 — Projects

> Оригинал: «let's add one more abstraction layer - we've got pages, there
> should be projects above them, and only then workspaces above»

## What it is

A third level of containment: **Workspace > Project > Document**. Every page
belongs to exactly one project, and the page tree, the documents list and
search can all be scoped to one.

Before this, a workspace was doing two jobs at once — the tenant/ACL boundary
*and* the only grouping above a page — so unrelated bodies of work shared one
tree and one sidebar. Projects split off the organizational half. They are
**not** a security boundary: access control stays exactly where it was.

## Design

- **DB**: new `projects` table (`id`, `workspace_id`, `name`, `description`,
  `created_at`), plus `documents.project_id` **NOT NULL** with a real FK.
  `documents.workspace_id` stays and is denormalized against
  `projects.workspace_id` — the S3 key layout, the graph predicate,
  `ingestion_jobs`, `activity_log` and the fulltext index all key off it.
  Services enforce `project.workspaceId === document.workspaceId`.
  No FK on `projects.workspace_id`, mirroring `documents.workspace_id`: in
  `AUTH_MODE=none` the demo workspace row need not exist.
  The migration (`20260907160044_projects_layer`) is hand-edited: it creates
  one `General` project per workspace, backfills every document, and only then
  sets the column `NOT NULL`.
- **Auth**: `WorkspaceSource` gains `'project'` — `AclGuard` resolves the
  `:id` param to its workspace via `AccessService.workspaceOfProject`. That is
  the *only* guard change; there is no project role, member table or
  visibility flag.
- **API**: `GET /v1/projects?workspaceId=` (`viewer`), `POST /v1/projects`
  (`editor`), `GET/PATCH /v1/projects/:id` (`viewer`/`editor`),
  `DELETE /v1/projects/:id` (`admin`). `ProjectsService` holds the two
  invariants ACLs cannot express: a project holding documents cannot be
  deleted (409 `reason: 'not-empty'`), and a workspace always keeps at least
  one project (400).
  `POST /v1/documents` requires `projectId`; `PATCH /v1/documents/:id` accepts
  it as a move. `GET /v1/documents` and `GET /v1/documents/tree` take an
  optional `?projectId=`; without it the tree still spans the workspace.
  `SearchRequest.filters.projectIds` filters post-ranking against PG, exactly
  like `filters.categories` (feature 02), reusing the same 5× over-fetch.
- **MCP**: new `knowledge_list_projects({ workspaceId })`; `knowledge_search`
  gains an optional `projectIds`. Document- and MR-scoped tools are unchanged —
  they derive their scope from the document.
- **Web**: `getProjectId()` / `setActiveProject()` in `lib/api.ts` mirror the
  active-workspace mechanism (localStorage + a `kn_proj` cookie so SSR renders
  the right tree); `stores/projects.ts` resolves a stored id against the
  roster and falls back to the first project. A project `<select>` sits under
  the workspace switcher in `AppSidebar`, breadcrumbs lead with the project
  name, `/projects` manages the roster, and the editor + upload pages carry a
  project picker (which doubles as the move control when editing).

## Notes

- **Moving a document moves its whole subtree.** Children would otherwise be
  orphaned into a project their ancestor no longer belongs to. Unless the same
  `PATCH` supplies a `parentId` inside the target project, the moved document
  is re-rooted — its old parent stays behind.
- **A parent must now be in the same project**, not merely the same workspace
  (`assertValidParent`). The tree is rendered per project, so a cross-project
  parent would simply be invisible.
- **The graph is untouched.** No `Project` vertex, no `BELONGS_TO` edge. This
  follows the precedent set by feature 08: *"the graph models semantic facts,
  not UI structure."* Project filtering happens in the PG post-ranking pass.
- **Cross-workspace moves are out of scope.** The target project must be a
  sibling in the same workspace; moving between workspaces would have to
  rewrite S3 keys, graph vertices and the fulltext index.
- Switching project does a full page reload, for the same reason switching
  workspace does: the tree, query cache and live subscription are all scoped.

## Future work

- Archiving a project instead of deleting it (`archived` flag + a filter on
  the switcher), so old work can leave the sidebar without moving its pages.
- Per-project defaults — a default category, a page template, a default
  relation type — now that there is somewhere to hang them.
- Bulk move: select several pages in the list and re-project them at once.
- Project-level ACLs, if isolation inside a workspace is ever needed. The
  `'project'` guard source is already the hook for it.
