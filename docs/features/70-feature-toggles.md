# 70 — Feature toggles

Issue [#604](https://github.com/hrustalq/knowledge/issues/604). Every workspace
used to get every section. A team that never records meetings still saw Memos,
and one without API specs still saw QA. Agents were offered the tools of
sections nobody used.

A workspace admin can now switch a section off. While it is off, the section
is not there for anyone in the workspace: the app does not draw it, its API
routes answer 404 and its MCP tools refuse.

## Decisions

- **Per workspace, admin-owned.** The toggle is a workspace setting, not an env
  var, because sections are a team's choice. There is no env ceiling: nothing
  here widens access, so there is nothing to clamp.
- **Absent, not forbidden.** A switched-off route is a 404 with
  `details.feature`, the same as a route that does not exist. A 403 would
  invite an access request for something no role can open.
- **Hidden, never deleted.** Switching a section off touches no data, and
  switching it back on brings everything back as it was.
- **Background work is out of scope.** The arbiter, the harvester and analytics
  recording keep running under their own settings (`analyticsEnabled`, chat
  bindings, agent schedules). A toggle hides a section; it does not stop the
  work behind it.

## The catalogue

`WORKSPACE_FEATURES` in `@knowledge/contracts` (identity) is the closed list
that the form, the guard and the MCP gate all read:

| Feature            | Web                                                       | REST (`@Feature`)                                                                  | MCP (`FEATURE_TOOLS`)                         |
| ------------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `workflows`        | `/workflows*`, Settings → Workflows, the page rail widget | `WorkflowsController`, `DocumentWorkflowsController`                               | list / start / get run                        |
| `knowledge-health` | `/knowledge-health`                                       | `KnowledgeHealthController`                                                        | —                                             |
| `qa`               | `/qa`, the test menu and suite on an API operation        | `v1/api-specs/:id/test-*`, `v1/workspaces/:id/test-environments*`, `v1/test-fixtures`, `v1/qa` | the test-suite, fixture and run tools, `qa_overview` |
| `analytics`        | `/analytics`, the page Insights widget, project analytics | the dashboard routes, `documents/:id/insights`, `projects/:id/analytics` (not the view beacon) | `get_page_insights`, `list_search_gaps`       |
| `captures`         | `/captures`, the capture session on a captured MR         | `CapturesController`                                                               | `CAPTURE_TOOLS` + `list_captures`             |
| `memos`            | `/memos*`                                                 | `MemosController`                                                                  | `list_memos`, `get_memo`                      |
| `conflicts`        | `/conflicts`, the page Contradictions widget              | `ConflictsController`                                                              | `list_conflicts`, `resolve_conflict`          |
| `assistant`        | `/assistant`, the editor's chat panel (⌘J)                | `v1/assistant/threads*`                                                            | —                                             |

Review, lint, suggest, ask and related (`POST /v1/assistant/{review,lint,…}`)
are not part of `assistant`. They are helpers inside other surfaces, and the
search sheet's Ask goes through them.

## Storage

`workspace_settings.disabled_features text[] NOT NULL DEFAULT '{}'`
(migration `20261220100000_workspace_feature_toggles`). Empty, or no row at all,
means every section is on. A value a later release drops from the catalogue
reads as nothing (`isWorkspaceFeature` filters it).

`FeaturesService` (`auth/features.service.ts`, in `AuthCoreModule` so every
process has it) reads the column through a 30 s per-workspace cache, as
`AuthPolicyService` does. A write drops this process's copy; other processes
catch up within the TTL.

## Surfaces

| Surface                                | What it does                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `GET /v1/workspaces/:id/features`      | `@Access('viewer','workspace',{guests:true})`: `{ workspaceId, disabled }`. The app reads it for every member |
| `PUT /v1/workspaces/:id/features`      | `@Access('admin','workspace')`: replaces the whole list; an unknown value is a 400              |
| Settings → **Features**                | Admin-only row: one checkbox per section, then Save (`FeaturesSettingsPage.vue`)                |

## Enforcement

**REST.** `@Feature('<key>')` sits on a controller or a handler beside
`@Access`. `AclGuard` resolves the route's workspace and calls
`FeaturesService.require` **after** the membership check, so the 404 tells only
a member that a section is off. Under `AUTH_MODE=none` the guard resolves the
workspace for a marked route even though it skips every other check, so a
toggle behaves the same in dev. A route without `@Access` has no workspace to
read, so `@Feature` does nothing there. Every marked route has one.

**MCP.** `trackTools` takes a gate that runs before every call. `McpService.featureGate`
finds the workspace from `workspaceId`, else `documentId`, else the run id of
`knowledge_get_workflow_run`. It checks membership (viewer, guests allowed) and
then the toggle. A tool missing from `FEATURE_TOOLS` keeps working while its
section is off, so a new tool of a toggleable section must join the map. The
spec fails if the map names a tool that does not exist.

**Web.** `stores/features.ts` holds the list. The router guard loads it before
the first route resolves, on the server too, so the nav, the routes and the
first frame agree. A route record carries `meta.feature`, and a match on any
matched record sends the reader to `/documents`. Lists built in script filter
with `features.isOn(…)`. A single element takes `v-feature="'<key>'"`, which
renders it `hidden` (SSR-safe; Tailwind's preflight makes `[hidden]` win). A
component that fetches gets `v-if` instead: hidden would still mount it, and
its query would 404. Queries a page owns for a section's widget are
`enabled: features.isOn(…)`.

## Not built

- No per-project toggles. A project is organizational; the workspace is the
  boundary.
- No live push of a change to other open tabs: they pick it up on their next
  load. The API refuses at once either way.
