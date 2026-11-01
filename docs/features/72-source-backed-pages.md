# 72 — Source-backed pages

Issue: [#674](https://github.com/hrustalq/knowledge/issues/674). PRs #684 (page link index, #673), #688
(single URL, read-only), #689 (extraction recipes), #690 (recipe page redesign), #691 (tree crawl), #693
(tree recipes), #694 (OpenAPI/AsyncAPI URL), #695 (dependent pages, sync trust), #696 and #697 (the
sentinel's "source changed" check, flag/propose).

## What

A **source-backed page** is a read-only page whose body belongs to an external URL and is replaced by each
new version of it. A **dependent page** links to it (or to one of its sections) or shares an entity key with
it, so it may stop being true when the source changes. An **extraction recipe** says where the content sits in
a source's HTML and how to turn it into the page. The three terms are in [`GLOSSARY.md`](../../GLOSSARY.md).

One connector kind, `web`, syncs three shapes of source:

| shape            | how it is made                                                                      | page                                          |
| ---------------- | ----------------------------------------------------------------------------------- | --------------------------------------------- |
| one URL          | **Add page → Link a source** (`/create/source`), or a Connectors-page `web` step     | markdown passes through; HTML through a recipe |
| a tree           | the same, with "also sync pages under this URL" (`config.crawl: 'tree'`)              | one page per URL, nested by URL path           |
| an API spec URL  | either entry point; detected, never chosen                                           | `kind: openapi` / `asyncapi` (feature 52)      |

A page linked from "Link a source" sits on a **hidden** connector it owns (`connectors.owner_document_id`). It
is left out of the Connectors list and managed from the page's **Source** rail widget. A Connectors-page
`web` connector is an ordinary visible one. Credentials are a `web` Connection per host (feature 69): a Bearer
token or a custom header, asked for inline only when the host refuses.

## Why

Copying a vendor page, a docs tree or a Swagger URL into the knowledge base meant re-copying it by hand, and
the pages written on top of it drifted without anyone noticing. Connectors covered vendor APIs and repos
only. Every adapter used a fixed converter, a pulled page could be edited locally (so the next pull became a
conflict MR), and nothing checked the pages that relied on a page when it changed. Dependent reindex
(feature 04) refreshes only the index, and the sentinel (feature 35) ran only on code PRs.

## Decisions

### Read-only, and new versions land directly

- **One predicate at the revision write.** `DocumentsService.createDraftRevision` refuses every writer but
  the page's own connector (`sourceConnectorOf`, `documents/source-backed.ts`) with 409
  `reason: 'source-backed'`. The editor, upload, REST and MCP revisions, git push (feature 71), merges and
  co-editing publishes all create revisions there, so nothing else enforces it. A branch is refused too, or a
  merge would land it. Comments and page fields (owner, category) stay editable. The detail route reports
  `sourceBacked`, and the app swaps Edit for a "Follows its source" note.
- **No merge request for a new version**, including a spec source. The staging step writes the revision
  directly and tells the connector's owner (`source.updated`). Watchers hear through `revision.finalized`.
  For `web` only, this overrides feature 52's "every synced spec change is an MR", because the upstream API
  has already changed.
- **Restore pauses.** Restoring an earlier revision from History pauses the source (`connector_links.paused_at`).
  A paused source keeps fetching and counts how many versions it is behind (`ahead_count`, `ahead_hash`), and
  writes nothing until **Resume**.

### Triggers and failures

- **Three triggers:** the schedule (a due check inside `ConnectorScheduleSweeper`, interval from
  `SOURCE_INTERVALS_MIN` = 15 min, 1 h, 6 h, 1 day, or manual), the connector's signed webhook (the Source
  widget's **Webhook…** mints a secret, shown once, for `POST /v1/connectors/:id/webhook` with
  `X-Hub-Signature-256`), and **Sync now** (UI, or `knowledge_sync_connector`).
- **Conditional GET.** The adapter stores `ETag` / `Last-Modified` as the link's `externalVersion` and sends
  `If-None-Match` / `If-Modified-Since`. A 304 or an unchanged content hash writes nothing and runs no check.
- **Transient failures retry inside the run**: timeout, 408, 429, 5xx and network errors (`isTransient`,
  `adapters/web-failures.ts`). Each retry is a scoped run delayed by `SOURCE_RETRY_DELAYS_MIN` (1, 5, 25
  minutes), and `Retry-After` can only make the delay longer. Once retries are exhausted the sync counts as
  failed (`failures`). Three failed syncs in a row raise a `failing` alert and never archive the page.
- **Gone is three 404/410s in a row** (`gone_count`, `SOURCE_FAILURE_LIMIT`), or three complete crawls in a row
  that no longer find a page. The page is archived, every page linking it is flagged `outdated` with "source
  removed", and the owner gets a `gone` alert.
- **Fetching** goes through `common/safe-url.ts` with an identifying User-Agent
  (`KnowledgePlatform-SourceSync/1.0`). Private addresses need `WEB_SOURCE_ALLOW_PRIVATE=true`. That flag is
  separate from `CONNECTOR_ALLOW_PRIVATE_URLS` because any editor can link a source, while only an admin sets
  up a connector. `robots.txt` is not consulted (decided on #674).

### Alerts

`source.alert` notifications, category `source`, go to the connector's owner in-app and by email on the
directed-email path, which honours mute and `emailDirected`. An unread alert on the same page coalesces with
the next one, and the latest kind wins. The kinds are `SOURCE_ALERT_KINDS`:

| kind       | when                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| `paused`   | a restore paused the source                                                  |
| `gone`     | the page was archived as gone                                                |
| `failing`  | three failed syncs in a row                                                  |
| `held`     | a version failed its recipe checks, or a spec no longer parses              |
| `breaking` | a new spec version has breaking changes (`ApiSpecDiffService`), whatever `apiBreakingChangePolicy` says |

### Extraction recipes

- **Declarative data only, never code.** A recipe (`SourceRecipe`, contracts) holds content and strip
  selectors, a heading map (`h1`…`h6` → level), expected landmarks, and normalization rules
  (`SOURCE_RECIPE_RULE_KINDS`: `drop-section`, `rename-heading`, `rewrite-links`). The pure half is
  `connectors/source-recipe.ts`. Selectors apply only to HTML. Rules apply to markdown sources too.
- **No recipe means the implicit one.** Linking makes no model call. Article scoring (Defuddle, through
  `import/parsers/html-to-markdown.ts`) extracts, and the checks compare against the last good version's
  baseline (`connector_links.baseline`: word count and h1/h2 headings). A version is held when no article is
  found, when its words fall below 40% of the baseline (`SOURCE_MIN_WORDS_RATIO`), or, with no landmarks,
  when fewer than half of the baseline's h1/h2 headings remain (only when the baseline had at least two). An
  approved recipe's checks are: the content selector hits, every landmark hits, and the 40% word floor.
- **A failed check holds the version, and output that fails is never published.** The page stays on its last
  good revision. `held_at`, `held_reason` and (for a spec) `held_detail` record why, the owner gets a `held`
  alert, and the `interpreter` agent drafts a recipe at once. `interpreter` is built in, has no tools and
  answers in JSON. The source outline is wrapped untrusted, and its spend bills as `source-recipe`.
- **A layout change that still passes** is detected by the structural fingerprint (landmark frame plus
  heading levels, `connector_links.fingerprint`). It sets `structure_changed_at`, and the widget shows "the
  source's layout changed" with a **Draft recipe** button. No model is called until someone presses it.
- **Recipes are immutable versioned rows** in `source_recipes`, one series per connector. A row has a
  `document_id` (page scope) or none (connector scope, the **tree recipe**). `SourceRecipesService.recipeFor`
  reads the page's active row first, then the connector's, so a page recipe **replaces** the tree recipe.
- **Review is a person's act.** `/documents/:id/source/recipe` (page) and
  `/settings/connectors/:id/recipe` (tree) are one workbench. It shows the recipe form with live selector
  hit counts, a before/after line diff or the rendered page, and the check list. Approve (or Save) is refused
  while any check fails. Preview, re-run and drafting read the **last fetched body** kept in the bucket
  (`body_hash`, `sourceBodyObjectKey`) and never re-fetch. A saved recipe whose output differs writes a new
  revision.
- **A saved tree recipe** clears the validators, `fingerprint` and `structure_changed_at` of every page
  without its own recipe, then queues an ordinary pull. Each page re-reads politely, and a failing page is
  held on its own. The tree preview runs on the root page's body by default, and **Preview on** lists only
  the crawled pages the caller can see.

### Tree crawl

- **Scope** is the root's origin plus its path, segment-bounded: `/docs` holds `/docs` and `/docs/x`, never
  `/docs-old`. `?query` and `#fragment` are dropped, and `/x`, `/x/` and `/x/index.html` fold to one page
  (`foldUrl`, `connectors/web-crawl.ts`).
- **Discovery** reads every `<a href>` in the fetched HTML, nav included, or markdown links in a markdown
  source, plus `sitemap.xml` (and a sitemap index) filtered to the scope. It lives in `WebAdapter.children()`.
- **Nesting** follows the URL path. The root URL is the root page, and a page hangs under its nearest ancestor
  path the crawl found, else under the root (`adapter.nest()`).
- **Politeness is constants:** one request at a time per host, a 1 s gap (`SOURCE_CRAWL_GAP_MS`), and
  `Retry-After` honoured.
- **Limits** are sparse `workspace_settings` columns under `WEB_SOURCE_CRAWL_*` env ceilings (Settings →
  Connectors, `GET/PUT /v1/sources/settings`). One crawl reads at most `maxPages` (200). A first crawl
  creating more than `confirmFirst` (50) pages, or a later one adding plus dropping more than
  `confirmChange` (20), parks the run in `review` (connector staging, feature 26). The reason shows above
  Approve all, and the root page's Source widget links to the run.
- **Absence counts only on a complete crawl.** A page whose extraction is held still counts as present. A
  run that hit the cap, failed, or could not fetch the root never counts an absence. A newly found page that
  fails the tree recipe creates no page: the run item fails, and the next crawl retries it.

### API spec sources

- **Detected:** a body that parses as JSON or YAML with a top-level `openapi`, `swagger` or `asyncapi` key
  (the `specKindOf` test). Recipes do not apply, and a spec URL has nothing to crawl.
- **Split specs are refused.** A non-internal `$ref` fails with "bundle the spec into one file": a 400 at link
  time, held on a later sync.
- **A version that no longer parses is held** with the parser's message in `held_detail`. The `held` alert
  fires once, and the next version that parses lands normally.

### Dependent pages

- **Deterministic pass first, no model.** `SourceDependentsService.revisionIndexed` runs in the ingestion
  processor once a source-backed page's new default-head revision is **first** indexed, because dropped keys
  need the new revision's edges. It flags `requested`, with a note naming what went, every page that either:
  - links an anchor the new version removed or renamed (heading slugs, or a spec's `operationAnchor`s,
    matched against `page_links.target_anchor`; a section whose text reappears under a new id counts as
    renamed, and the note names the new id); or
  - holds a live edge to an entity key the new version's frontmatter or spec facts dropped
    (`GraphService.revisionEntityKeys` before minus after).

  Pages already flagged, archived, or themselves source-backed are skipped.
- **Then the sentinel judges the rest.** The same call queues a `sentinel` run (trigger `source`, owned by the
  connector's owner) with `input.sourceChange = { documentId, fromRevisionId, toRevisionId, flagged }`. A
  run still waiting for the same page absorbs a newer version by moving `toRevisionId` forward. There is no
  run without a model, an owner, or a linking page, so the deterministic flags are the floor. The candidates
  are pages that link the whole page or at least one **changed** section; a page whose every link targets an
  unchanged section is skipped. Each candidate sees only the changed sections (a heading-section diff, or the
  spec's changed operations), one `source-judge` call each, up to `SOURCE_JUDGE_MAX_PAGES` (20). Overflow,
  and any restricted page (the run reads under a whole-workspace scope), is flagged `requested` as "not
  checked", and the note names only the source page.
- **Flag or propose**, per source: `config.misalignment` (`SOURCE_MISALIGNMENT_MODES`, default `flag`), set on
  the Source widget (`PATCH /v1/documents/:id/source`) and the connector's `web` step. Both modes flag the
  pages found wrong as `requested`, which notifies their owners. `propose` also opens the drafted fix as a
  merge request through `AgentFindingsService`, acting as the connector's owner, who needs the editor role
  (otherwise the flags still go out). In `propose` mode the judge also drafts fixes for the pages the
  deterministic pass flagged (`flagged`, #697), and the publisher keeps the pass's note on them.
- **The worker generates, the API publishes.** `SourceChangePublishSweeper` (API-only, `DriftModule`) claims
  each finished run once (`input.publishedAt`) and skips runs older than 24 h. A page verified after the run
  started, or already `outdated`, is left alone. `DriftPublishSweeper` no longer claims these runs.

### Trust follows the sync

`verificationStateFor` takes `source` (`SourceSyncHealth`). The order is `outdated` > open issue >
`requested` > sync health. A sync is healthy when it is not paused, not held, has no failing streak, and,
when it runs on a schedule, was last answered within two intervals; a manual-only source has no clock to fall
behind. Healthy reads `verified`, anything else `expired`. Verify is refused with 409 `source_backed`, the
review-interval stamp and its expiry do not apply, and the bar reads "Synced from \<host\> · \<time\>".
`sourceSyncOf` feeds the TS predicate, and `sourceStateSql` is its CASE twin in the knowledge-health CTE.
Change the two together.

### Gating

`WEB_SOURCES_ENABLED` (default off) is the ceiling over the workspace `sources` toggle (`WORKSPACE_FEATURES`,
feature 70). Either one off 404s the routes (`@Feature('sources')`) and hides the web entry points
(`meta.feature`). The env flag also stops a `web` connector from being created or run
(`ConnectorsService`). The toggle does not: background work keeps going under a switched-off section, as
feature 70 promises.

## Surface

```
GET    /v1/sources/settings?workspaceId=                admin   crawl limits: requested / ceiling / effective
PUT    /v1/sources/settings                             admin   sparse; null inherits the ceiling
POST   /v1/sources                                      editor  Link a source: page + hidden connector + link, first version read in the request
GET    /v1/documents/:id/source                         viewer  the Source widget's state (DocumentSourceInfo)
PATCH  /v1/documents/:id/source                         editor  interval, misalignment
POST   /v1/documents/:id/source/pause | resume          editor
POST   /v1/documents/:id/source/restore                 editor  restore a revision; pauses the source
POST   /v1/documents/:id/source/webhook                 editor  mint a signing secret (shown once)
POST   /v1/documents/:id/source/recipe/preview          editor  run a recipe over the last fetched body
PUT    /v1/documents/:id/source/recipe                  editor  save / approve; refused while a check fails
POST   /v1/documents/:id/source/recipe/draft | dismiss  editor  ask the interpreter / reject its draft
GET    /v1/connectors/:id/source/recipe                 viewer  the tree recipe, preview page picker
POST   /v1/connectors/:id/source/recipe/preview         editor
PUT    /v1/connectors/:id/source/recipe                 editor  save, then re-read every page without its own recipe
POST   /v1/connectors/:id/source/recipe/draft | dismiss editor
```

Web: `/create/source` (Link a source, from the new-page menu), the **Source** rail widget on a source-backed
page, **Restore** in History, `/documents/:id/source/recipe`, `/settings/connectors/:id/recipe`, and the
`web` step in the connector setup (URL, crawl toggle, credential, misalignment). MCP adds no tool:
`knowledge_sync_connector` is Sync now, and `knowledge_create_revision` on a source-backed page answers the
same 409 as REST.

## Data and rollback

| Migration                             | Adds                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| `20261225100000_page_links`           | `page_links` (#673), current default-head links only; backfill with `make page-links-backfill` |
| `20261226100000_web_sources`          | `connectors.owner_document_id`; `connector_links` `paused_at`, `ahead_count`, `ahead_hash`, `failures`, `gone_count`, `retry_attempt`, `retry_at` |
| `20261227100000_source_recipes`       | `source_recipes`; `connector_links` `baseline`, `fingerprint`, `structure_changed_at`, `held_at`, `held_reason`, `body_hash` |
| `20261228100000_source_crawl_settings` | `workspace_settings.source_crawl_max_pages` / `_confirm_first` / `_confirm_change` (sparse) |
| `20261229100000_source_held_detail`   | `connector_links.held_detail`                                                             |

All additive. Columns are nullable or defaulted, so the previous image runs against a migrated database.
A rollback to an image before #688 has no `web` adapter and no read-only predicate. Its `web` connectors stop
syncing, and their pages become editable until the image is rolled forward again. `source_recipes` and `page_links` are filed in `workspace-teardown.inventory.ts`.

## Deliberate deferrals

- Recipe review over MCP. It is web only in v1.
- Two-way sync, executable per-source scripts, `robots.txt`, and dependents found by similarity alone (no
  link, relation or shared key). All out of scope on #674.
- `operationAnchor` gives `GET /pets` and `GET /pets/{id}` the same anchor (the web's DOM-id scheme), and
  `specChangedSections` builds a channel removal's anchor with a null method. The entity-key path still
  catches such a removal.
- Crawl run warnings are stored as text in the worker's locale.
- Never run live: the interpreter's draft and the source judge on a real model (gen-api had no credit),
  alert email and webhook delivery, HTML and crawls behind credentials, and crawl politeness against a real
  slow host or a 429.

## Verification

Specs in `apps/api/test`:

- `web-sources.spec.ts`: the adapter's fetch, conditional GET and credentials, and `fetchFailed` (retry,
  gone, failing).
- `source-recipes.spec.ts`: extraction, rules, checks, recipe parsing and `SourceRecipesService`.
- `web-crawl.spec.ts`: crawl rules, the adapter's crawl and the crawl bookkeeping.
- `web-spec-sources.spec.ts`: spec bodies, `specHeld` and `specLanded`.
- `source-dependents.spec.ts`: source-backed trust, anchors and `revisionIndexed`.
- `source-judge.spec.ts`: what changed, the sentinel's judging, queueing the check and publishing the verdicts.

Each phase was also run live on a side API and worker against a local fixture site, with a fake
OpenAI-compatible model standing in for the judge.

Release needs `WEB_SOURCES_ENABLED=true` in the GitHub `production` environment, and `make page-links-backfill`
once in the production API container.
