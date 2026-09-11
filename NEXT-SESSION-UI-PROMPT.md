# Next session: the web UI for feature 26 (connector staged tree import)

Paste everything below the line as the opening prompt.

---

Implement the web UI for **docs/features/26 — connector staged tree import**. The
backend is done, merged and verified; nothing on the API side needs changing
unless you find a genuine gap. Read `apps/api/src/connectors/` and
`packages/contracts/src/index.ts` (search `docs/features/26`) before writing
anything.

## What the backend already does

A Confluence pull used to flat-list a whole space and write every page
immediately as a sibling under one parent — nothing was reviewable, pausable or
undoable, and the happy path logged nothing. Now:

- **Both Confluence adapters walk the tree.** `ConnectorAdapter.children(ctx, parent)`
  is optional (the `push?` precedent); `ExternalRef` gained `parentExternalId`
  and `hasChildren`; `ConnectorCapabilities` gained `tree`. Jira, Notion and
  markdown-git are untouched and still take the flat `list()` path.
- **Every page is a row.** `connector_run_items` — self-FK `parent_item_id`,
  modelled on `workflow_run_nodes`. Markdown lives in MinIO
  (`workspaces/{ws}/connector-runs/{runId}/items/{itemId}/{staged,incoming}.md`),
  not in the row.
- **Runs have modes and phases.** `connectors.sync_mode` (`auto` | `review` |
  `step`, default `auto`) is frozen onto `connector_runs.mode` at creation;
  `phase` is `discovering | fetching | awaiting-review | applying | reverting`;
  `status` gained `paused`, `awaiting-review`, `cancelled`.
- **Pause is real.** The processor loops over budgeted slices
  (`CONNECTOR_SYNC_BATCH`, default 25), re-reading the run row between each, and
  checkpoints + re-enqueues before `CONNECTOR_SYNC_TIMEOUT_MS` so a large space
  finishes instead of dying.
- **Hierarchy is opt-in.** `connectors.preserve_hierarchy` defaults to **false**,
  so every existing connector lands pages exactly where it does today. Turning it
  on never moves pages already imported. A skipped parent is transparent: its
  children re-root rather than being stranded.
- **Revert works.** A created page is torn down via
  `ProjectCascadeService.cascadeDocuments` (the product's only page-delete path,
  split out for this); an updated one is restored by writing a **new** revision,
  never by deleting one. The link's hashes are rolled back so the next sync does
  not immediately redo the undo.
- **AI is per-item and never automatic**, routed through the existing `drafter`
  agent (no new built-in): `cleanup` repairs the conversion, `merge` is offered
  only on a `conflict` item and is three-way (base = last agreed revision).
- **`CONNECTOR_DEBUG=true`** traces every upstream request, every level of the
  walk, and the decision taken per page.

## The API you are building against

Run `make api-client` first — `apps/web/src/api/schema.d.ts` is stale until you
do. All routes are `@Access(…, 'connector-run')`.

```
GET   /v1/connectors/runs/:runId                       → { run: ConnectorRunInfo }
GET   /v1/connectors/runs/:runId/items                 → ListConnectorRunItemsResponse
GET   /v1/connectors/runs/:runId/items/:itemId         → ConnectorRunItemResponse
PATCH /v1/connectors/runs/:runId/items/:itemId         → { item }   { title?, markdown? }
POST  /v1/connectors/runs/:runId/items/:itemId/ai      → { item }   { op: 'cleanup' | 'merge' }
POST  /v1/connectors/runs/:runId/items/:itemId/events  → ConnectorItemEventResponse
                                                          { type: APPROVE|SKIP|REJECT|RETRY|REVERT, subtree? }
POST  /v1/connectors/runs/:runId/events                → ConnectorRunEventResponse
                                                          { type: PAUSE|RESUME|NEXT|CANCEL|APPROVE_ALL }
```

`ListConnectorRunItemsResponse.items` is **flat rows**; build the tree from
`parentItemId`. `ConnectorRunItemResponse` carries `markdown` (what would be
written), `incoming` (the unedited conversion, non-null only when it differs) and
`localHead` (the page's current content, for `update`/`conflict` items).

**Use `allowedRunEvents(run)` and `allowedItemEvents(item)` from
`@knowledge/contracts` for button enablement.** They are exported precisely so
the buttons you render and the transitions the API accepts are one list. Do not
re-derive them from `status` in a component.

## What to build

1. **`apps/web/src/pages/ConnectorRunPage.vue`** at
   `/settings/connectors/runs/:runId`, `meta.fill`. Take the import wizard's
   frame (`ImportPage.vue`): fixed header, flexing body, **one action bar** at the
   bottom carrying the run controls (Pause / Resume / Next / Cancel / Approve
   all). Poll the run while it is not terminal; `ConnectorRuns.vue` already uses
   `refetchInterval: 4000`.

2. **`components/connectors/ConnectorRunTree.vue` + `ConnectorRunTreeNode.vue`.**
   Recursive, `Collapse`-based, indent by depth — follow `SidebarTreeNode.vue`,
   but the item tree arrives whole so there is **no lazy level fetch**;
   `hasChildren` is only a discovery indicator (a branch the walk has not reached
   yet). Each row: status chip, action badge (create / update / unchanged /
   conflict), title, and the per-item actions. Branch rows offer Approve subtree
   and Skip subtree (`subtree: true`).

3. **`components/connectors/ConnectorItemReview.vue`** — the prepared document.
   Deliberately the same shell as `ImportReview.vue`: `RichEditor` with the title
   in the `#lede` slot, `defineExpose({ flush })` so the page reads non-stale
   markdown, and a rail carrying provenance (Confluence URL, version, depth), the
   item's `warnings`, and the two AI buttons. For a `conflict` item show
   `DiffView.vue` (incoming vs. `localHead`) with a toggle to the editor. An item
   whose `aiOp` is set must carry a visible badge — a page a model rewrote must
   never be indistinguishable from one Confluence sent.

4. **Progress** — reuse `ParseProgress.vue` unchanged. It already handles "the
   worker owns this half, so report `null` rather than a number the client
   invented", which is exactly discovery (unbounded) vs. fetching
   (`done / discovered`).

5. **`ConnectorRuns.vue`** — link each row to the new page; surface `phase` and
   the `awaitingReview` count as a badge.

6. **`setup-machines.ts`** — the two Confluence kind machines gain the optional
   `rootPageId` question; the core wrapper's options step gains `syncMode` and
   `preserveHierarchy`. **New Confluence connectors should be created
   `preserveHierarchy: true, syncMode: 'review'`**; existing rows keep the column
   defaults. Extend `setup-machines.check.ts` and run it:
   `node --experimental-strip-types apps/web/src/components/connectors/setup-machines.check.ts`

7. **`apps/web/src/api/live-cache.ts`** — extend the `connector.*` rule (~:125) to
   invalidate `['/v1/connectors/runs/{runId}/items', { runId: e.subjectId }]`.
   Note the asymmetry, it matters: `connector.run.started|succeeded|failed` carry
   **the connector id** in `subjectId`, while the new
   `connector.run.paused|resumed|awaiting-review` and `connector.item.*` carry
   **the run id**. While you are there, fix the misplaced docblock at ~:113-124,
   where the connector paragraph sits above the `agent.run.*` rule.

8. **i18n** — new strings in `apps/web/src/i18n/{en,ru}`. Follow feature 18's
   rules: translate composed sentences **whole**, never concatenate fragments;
   module-scope label maps hold **message keys** resolved as `t(MAP[x])` at the
   render site, and the render site must actually resolve them. Russian runs
   15–20% longer — shorten the Russian copy rather than widening the layout.

9. **`docs/features/26-connector-staging.md`** — the feature doc, in the voice of
   19 and 16: what, why, the decisions and what they cost, deliberate deferrals,
   verification.

## Constraints

- A `default:` in a Swagger decorator promotes the property to **required** in
  the generated client; describe defaults in `description:`. A nullable DTO field
  needs an explicit `type:`. (Both already handled on the API side — this is for
  if you touch a DTO.)
- Don't add a charting or tree library. The repo has `@tanstack/vue-virtual` but
  uses it on flat lists only; the item tree does not need it below ~1000 rows,
  which is `CONNECTOR_SYNC_MAX_ITEMS`.
- There is no test suite. Verification is `make check` plus the flow below.

## Verify

```bash
make check          # lint + typecheck + build
make api-client     # regenerates openapi.json + schema.d.ts (both committed)
make dev
```

Then, against a Confluence Server space with at least three levels of nesting and
`CONNECTOR_DEBUG=true`:

1. Start a `review` pull. The tree should fill in **branch by branch**, matching
   the real hierarchy.
2. **Pause mid-discovery** — the worker stops within one item; **Resume**
   continues rather than restarting. Repeat with **Next** in `step` mode.
3. Open a staged item, edit it, run **cleanup**; the AI badge appears and
   `incoming` still holds the original.
4. Approve one subtree — pages nest exactly as in Confluence, and a **skipped
   parent leaves its children re-rooted, not stranded**.
5. **Revert** one created page and one updated page: the first is deleted with
   its link, the second gains a new revision restoring the old content.
6. **Sync twice.** The second run must report every item `unchanged`, create
   nothing, and produce no duplicate pages, item rows or parent changes. This is
   the single most important check.
7. Confirm a connector left at `preserveHierarchy=false, syncMode='auto'` pulls
   exactly as it did before the feature.
