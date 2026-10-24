# 65 — Workspace deletion

Issue [#479](https://github.com/hrustalq/knowledge/issues/479). Until this
change a workspace could not be deleted. Test tenants and workspaces created by
mistake stayed forever: their pages showed in platform-admin views, their
connectors and bots kept syncing, and their bytes stayed in MinIO.

Deleting one is not a single-row delete. House policy puts no FK on
`workspace_id`, so PostgreSQL cascades nothing. Over 90 tables carry the column,
and the workspace also owns objects under `workspaces/{ws}/`, ArcadeDB vertices
and BM25 documents.

## Decisions

- **A tombstone, then a sweeper.** The request sets `workspaces.deleted_at`.
  An API-side sweeper does the teardown, which doubles as crash recovery for a
  delete that touches every table and three external stores.
- **Workspace admin** is enough to delete. Platform admin is not required.
- **No undo, export or grace period.** Export (feature 45) already covers
  projects.

## Surfaces

| Surface                                          | What it does                                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `GET /v1/workspaces/:id/deletion-preview`        | `@Access('admin','workspace')`. Counted holdings: projects, pages, revisions, stored files, connectors, chat bindings, live API keys, published sites |
| `DELETE /v1/workspaces/:id?confirm=<name>`       | `@Access('admin','workspace')`. Anything but the exact name is a 400 that changes nothing        |
| Settings → Access → **Delete this workspace**    | Shown to workspace admins at the foot of the Members tab: the manifest, then the typed name (`DeleteWorkspaceDialog.vue`) |

There is no MCP tool. Deleting a tenant is not an agent's act.

## The tombstone: gone at once

`WorkspacesService.remove` runs one transaction:

1. A guarded `updateMany(where deletedAt: null)` sets `deleted_at`. The guard is
   the idempotency claim: a second request finds nothing to claim and gets a 404.
2. The entry points that never pass `requireRole` close through the switch
   their own reader already honours. Nothing has to learn a new predicate:
   - the `publishing_settings` row is deleted, and the code default publishes
     nothing, so share links, sites and public embeds 404;
   - API keys narrowed to the workspace and its SCIM tokens get `revoked_at`;
   - identity providers, connectors, chat integrations and agent triggers get
     `enabled = false`, and agents get `schedule_enabled = false`.

Everything else reads the tombstone itself:

- `AccessService.workspaceExists` 404s on it, and `requireRole` calls
  `workspaceExists` ahead of the platform-admin shortcut. That covers every
  `@Access` route and every MCP guard, including the routes that resolve their
  workspace off a child row (`workspaceOfDocument` and the rest), which
  outlives the tombstone until the sweep. `AUTH_MODE=none` still returns before
  any check, as it always has.
- `GET /v1/workspaces`, `GET /v1/me` and the sign-in response leave it out.
- The ingestion processor fails a job for a tombstoned or missing workspace
  without throwing, so BullMQ does not retry it.

The `workspace.deleted` audit entry records the actor, the name and the
preview counts. `audit_logs` is the one table the teardown keeps, so the entry
outlives every row it counts.

## The teardown

`WorkspaceTeardownSweeper` runs in the API only, because it needs storage, the
graph and BM25. It ticks every 60 s with back-pressure, and the delete request
also kicks it once straight away. Each pass of `WorkspaceTeardownService.teardown(ws)`:

1. **Waits** while an ingestion job for the workspace is `running`. That job
   would write the graph and BM25 after they are cleared. New jobs refuse the
   tombstone, so this only waits out the last one.
2. **Pages** go 200 at a time through `ProjectCascadeService.cascadeDocuments(ids, ws, { external: false })`.
   This is the same teardown of the revision DAG, merge requests and threads that
   a project's "delete everything" uses. Each batch commits on its own.
3. **Workspace rows** go in one transaction: `assistant_messages` by thread
   (the one child with a non-cascading FK and no `workspace_id`), then every
   `workspace` table of the inventory, in order.
4. **External state**: `purgePrefix('workspaces/{ws}/')` deletes every version
   of every object (revisions, attachments, imports, connector items, exports,
   embed snapshots, draft checkpoints). Project avatars, which live under
   `avatars/projects/`, are purged by key. Then
   `GraphService.deleteWorkspaceGraph` and `FulltextProvider.deleteWorkspace`
   run. Failures are logged and swallowed, as in the project cascade: nothing
   can read the workspace any more, so what is left is unreferenced garbage.
5. **The `workspaces` row**, last, in a transaction that first checks no
   document reappeared (a sync already in flight at the tombstone). If one
   did, the tombstone stays for the next pass.

Every step deletes by id or by workspace, so a pass interrupted anywhere just
leaves the tombstone, and the next tick repeats the work without harm.

This order differs from `ProjectCascadeService` in one place. There, external
cleanup comes after the PG commit, so a live row never points at missing
bytes. Here nothing is live once the tombstone commits, so the objects can go
before the `workspaces` row. Keeping that row until last is what makes the
teardown resumable.

## The inventory

`apps/api/src/workspaces/workspace-teardown.inventory.ts` files every Prisma
model under one of five fates:

| Fate        | Meaning                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------- |
| `workspace` | Has `workspace_id`; deleted by it. **Key order is deletion order**                                 |
| `audit`     | Has `workspace_id`; kept. Only `AuditLog`                                                           |
| `page`      | Goes with its document in `cascadeDocuments`                                                       |
| `parent`    | No `workspace_id`; leaves with a workspace-owned parent through an `ON DELETE CASCADE` FK          |
| `platform`  | Not owned by a workspace (`User`, `Session`, …, and `Workspace` itself, deleted last by hand)       |

The object is `satisfies Record<Prisma.ModelName, …>`, so typecheck fails on
an unfiled model. `workspace-teardown.inventory.spec.ts` checks the same
against `Prisma.dmmf`. It also fails when a `workspace_id` table is filed as
anything but `workspace` / `audit` / `page`, and when the order breaks a
RESTRICT FK (runs before definitions; terms, connectors and sites before
projects; members last). **A new table must be filed before it ships.**

## The browser

- After a delete, `useWorkspacesStore().forget(id)` refreshes the roster. If the
  deleted workspace was the active one, it switches to the first remaining one
  with a full reload, as any switch does.
- A `kn_ws` cookie that names a workspace the caller cannot see makes the SSR
  shell (`prefetchShell`) fetch the roster and render the first listed
  workspace. That happens when the projects fetch fails, or comes back empty,
  as it does under `AUTH_MODE=none`. `entry-client` adopts the same id before
  hydrating, so the client's API calls agree with the HTML.

## Also fixed

`ProjectCascadeService.deleteRows` now deletes `merge_request_checks` before
`merge_requests`. The FK is RESTRICT, so a project "delete everything" failed
whenever one of its pages had a lint or breaking-change check.

## Built differently from the issue

- The issue asked for a shared predicate that every background path (sweepers,
  connector sync, chat, triggers, public resolvers, API-key/SCIM/SSO
  resolution) would read. Closing those paths with the switches their readers
  already honour does the same job in one transaction, and touches none of the
  ~30 readers. A predicate would not close the race either: a path that checked
  it a moment before the tombstone still writes afterwards. What closes the
  race is the ingestion wait (step 1) and the document re-check (step 5).
- No partial index on `deleted_at`. Prisma cannot express one, and the
  `workspaces` table is tiny.

## Verification

- `test/workspace-teardown.inventory.spec.ts`: the inventory is complete and
  ordered.
- `test/workspace-delete.e2e-spec.ts` (live infra, `AUTH_MODE=api-key`, non-admin
  people) seeds a workspace with a project, an indexed page, a connector, a share
  link, a site and API keys. It checks the 403 for a viewer and the 400 for a
  wrong `confirm`. Between the tombstone and the sweep it checks the 404s (`:id`
  routes, a child-row route, the share link, the site), absence from the list and
  from `/v1/me`, and the 401 for a narrowed key. It then crashes a teardown after
  its first page batch and checks the next pass completes it. Finally it asserts
  zero rows in every `workspace` table, zero objects under the prefix, zero
  ArcadeDB vertices, and the kept audit entry.
