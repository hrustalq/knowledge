# 84: Workspace home

Issue [#1243](https://github.com/hrustalq/knowledge/issues/1243). The shape brief is
[a comment on it](https://github.com/hrustalq/knowledge/issues/1243#issuecomment-6979053208).

## What

`/` used to redirect to `/documents`. Recent pages, activity, knowledge health, review queues and agent runs each had
their own screen, and nothing showed them together. `/` is now a home for the whole workspace. The project page
([24](24-project-page.md)) stays the per-project view.

The home shows six widgets. Each one sits in a fixed zone:

| Widget            | Zone | Backed by                                                                                                 |
| ----------------- | ---- | --------------------------------------------------------------------------------------------------------- |
| `metrics`         | top  | `KnowledgeHealthService.summary` (pages, `verified`, `stale`), an open-MR count, `AnalyticsQueryService.overview` (unanswered searches) |
| `actions`         | top  | No read. Links to `/create`, `/upload`, `/assistant` and `/workflows`.                                    |
| `needs-you`       | main | `MergeRequestsService.listWorkspace({ reviewerId: me, status: 'open' })` + `NotificationsService.list({ unread })` |
| `recent`          | main | `recentPages` (lifted from the project overview)                                                          |
| `activity`        | side | `ActivityService.list`                                                                                    |
| `agents`          | side | `AgentRunsService.list({ status: 'running' })`, keeping only name, stage and start time               |

## How

- **One read.** `GET /v1/workspaces/:id/home` (`@Access('viewer', 'workspace', { guests: true })`) returns the layout
  and the data of each widget the caller sees. A widget outside the layout is never queried. Every widget reads
  under the caller's `AccessScope`. Nothing is stored except the layout.
- **What a guest sees.** A guest gets what their own routes would give them: pages, activity and their inbox. The
  merge-request, agent-run, knowledge-health and analytics routes refuse guests, so the home leaves those numbers
  null and drops the `agents` widget.
- **Gating.** A metric whose section is off in `disabled_features` (`knowledge-health`, `analytics`) is null, never
  zero. The same applies to a quick action whose section is off (`assistant`, `workflows`). Unanswered searches are
  shown to workspace admins only, because `/v1/analytics/*` is admin-only.
- **Layout.** `workspace_settings.home_widgets` (JSONB) holds the shown `HOME_WIDGETS` keys in order:
  - A key left out is hidden.
  - The order applies within a zone (`HOME_WIDGET_ZONE`).
  - Null is the built-in layout.

  `homeLayoutOf` (contracts) is the one reader. It drops unknown keys and repeats, so a stored list survives a
  widget being removed from code. `PUT /v1/workspaces/:id/home/layout` (`@Access('admin', 'workspace')`) replaces
  the list, and `{ widgets: null }` resets it.
- **Customize.** A workspace admin edits the layout in place on `/`:
  - Every widget becomes a slot with move up, move down and show/hide controls. There is no drag library, and every
    control is reachable by keyboard.
  - A re-shown widget says it appears after saving.
  - Reset sends null rather than a copy of the default, so the workspace keeps following the built-in layout as
    widgets are added.
  - The pure helpers are in `modules/home/model/layout-draft.ts`.
- **SSR.** entry-server prefetches the home read (`prefetchForRender`), so the page renders with JavaScript off.
  Customize mounts only after hydration.

## Not done

- Per-user layouts.
- Metrics that would need new event rows.
- Workflow runs. They have their own page, and running agents covers the background work.
