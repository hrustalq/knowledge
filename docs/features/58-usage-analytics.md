# 58 — Usage analytics: page reads, read time, search gaps, and who is reading

Issue [#79](https://github.com/hrustalq/knowledge/issues/79), shipped as five
PRs (#331–#334 and the one carrying this document). Before it, nobody could
tell which pages get read, what people search for and do not find, or how much
of the traffic comes from agents rather than people. The only traces were the
backtest's JSONL measurement of each search and `api_keys.last_used_at`.

Now every read, search and MCP tool call is one event row in PostgreSQL, and
every number on screen is a rollup over those rows at read time. Each number
splits three ways: people reading, a model answering a person (the assistant
and the chat bots), and agents working on their own. Much of this product's
traffic is the third kind, so that split matters more here than in a
human-only wiki.

## What

- **A page's Insights** (rail widget, every page): 30 days of views by traffic
  class, unique readers, median read time, the last time a person read it, and
  a daily chart.
- **A project's Reading** (project overview, editors): totals, the stacked
  daily chart, the most read pages, pages never read, and dead pages.
- **Knowledge health** gains a **Last read** column and the `unread` / `dead`
  filters ([feature 40](40-knowledge-health.md)).
- **`/analytics`** (workspace admins, beside Knowledge health), with five tabs:
  - **Overview:** views, unique readers, median read, searches, zero-result
    share, click-through, assistant questions and MCP calls, plus the daily chart.
  - **Pages:** most read, never read, dead.
  - **Search:** top queries, queries that found nothing, and queries whose
    results nobody opened.
  - **Agents:** MCP calls by tool and by API key, and the assistant's volume.
  - **Settings:** recording on/off and retention.

  A range (7 / 30 / 90 days) applies to every tab, and a traffic filter
  (All / Humans / Assisted / Agents) to every tab but Agents. Each list exports
  as CSV.
- **Two MCP tools:** `knowledge_get_page_insights` and
  `knowledge_list_search_gaps`, the second being where an agent finds the
  pages worth writing next.

## The rules

### Events, never aggregates

Three tables, all append-only apart from one heartbeat column:

| table | one row per | written by |
| --- | --- | --- |
| `page_views` | a page opened in the app, or read over REST, MCP, the assistant or an agent run | the web beacon; `AnalyticsRecorder.view()` for the rest |
| `search_queries` | a search, from any surface | `SearchService.search` when the caller passes a context |
| `mcp_tool_calls` | an MCP tool invocation, HTTP or stdio | the `trackTools` wrapper in `mcp-tools.ts` |

There is no summary table (CLAUDE.md, "No stored aggregate tables"). Every
count comes from `AnalyticsQueryService` over the rows, so a dashboard and its
CSV export cannot disagree.

### Channel and traffic class

The recorder resolves a **channel** centrally (`channelFor`): a caller that is
not a person at a browser names its surface (`mcp`, `assistant`, `chat`,
`agent`), and the principal decides the rest. A `kn_` key is `api`. A session
or the dev principal is `web`. A principal with `mode: 'api-key'` and no key
is `agent`, never `api`: that shape is a background run acting for its owner.

The **traffic class** is derived, never stored (`trafficClassFor` in
`@knowledge/contracts/analytics`):

| class | channels |
| --- | --- |
| `human` | `web` |
| `assisted` | `assistant`, `chat` |
| `agent` | `api`, `mcp`, `agent` |

`channelsForTrafficClass` is its inverse, so `?traffic=` stays a
`channel = ANY(…)` in SQL.

### Web reads come from the page, not from the content route

`GET /v1/documents/:id/content` is also called by SSR and prefetch, so
counting it would count pages nobody looked at. A web read is written only by
the page's own beacon:

- `POST /v1/documents/:id/views` opens a view, keyed by a client-made `viewId`,
  so a replay is a no-op. `@Access('viewer','document')` means page
  permissions apply before the handler runs.
- `POST /v1/analytics/views/:viewId/heartbeat` reports the view's total active
  time. It is one guarded `UPDATE`:
  - the time only grows, and is capped at `ANALYTICS_READ_TIME_CAP_MS`;
  - it only touches `channel = 'web'` rows carrying the caller's reader key.

The tracker (`apps/web/src/lib/page-view.ts`) pauses while the tab is hidden
and flushes on `pagehide`. Both routes go through `PublicRateLimiter`
(120/min per principal, failing open) and answer 204 even when the hit is
dropped. `AnalyticsRecorder.view()` drops `web` on purpose.

### Click-through

A result link from the app carries `?sid=<searchId>&rank=<n>`
(`app-search-source.ts`). The page puts them on its view and strips them from
the URL. CTR is web searches with a clicked result divided by web searches
that found something. Only the app can click, so **no click** lists web
searches only; an agent's search never lands there.

A person re-running one query within 10 s (toggling a filter) is one search.
That collapse happens at read time, in one place: `searchCtesSql`. Rows with no
reader key always count.

### Anonymous only

`user_id` is never stored. The only reader identity is `reader_key`, an HMAC
of the user id **within one workspace**, so the same person in two
workspaces is two unrelated keys. The secret is `ANALYTICS_READER_SECRET`, or
one derived from `SETTINGS_ENCRYPTION_KEY`. When both are empty, a
per-process key is used and a boot warning says unique readers are counted per
process.

With `DNT: 1`, `Sec-GPC: 1` or `navigator.globalPrivacyControl`, the event
still counts but `reader_key` is null. Such a view adds to views and never to
unique readers. A heartbeat's `noTrack` must match its view's.

API key rows carry `api_key_id`. The Agents tab shows a key's name and prefix,
never its hash.

### Rollups respect page permissions

Every rollup that returns pages takes an `AccessScope` and filters with
`visibilitySql` and `listedSql` ([feature 48](48-page-permissions.md)). A
page the caller may not open contributes neither a title nor a count. Views
are counted through `documents`, so a deleted page's views drop out with it.
A moved page takes its views along: the project filter reads the page's
project now, not the one denormalized on the row.

### Never read vs dead

`read-signals.ts` holds the one predicate, read by both the project lists and
Knowledge health:

- **never read**: no human view, ever;
- **dead**: no human view within `ANALYTICS_DEAD_PAGE_DAYS`.

Both match nothing until the workspace's first recorded view is older than
that window. Before then "no views" means "not counted yet", and a fresh
install must not call every page dead. In production these lists stay empty
for about 90 days after release.

### Recording never fails the request

Every recorder method swallows its own failure (the
`ActivityService.record` rule). A broken analytics write never fails the
search, read or tool call it describes. Searches nobody typed are not
recorded: the backtest replay, and the PR-drift candidate search in
`agent.executor.ts`.

### Settings: the env is a ceiling

`workspace_settings.analytics_enabled` and `analytics_retention_days` are a
sparse override; null inherits. `effectiveAnalytics` clamps them: a
workspace may turn recording off or keep rows for less, never turn it on past
`ANALYTICS_ENABLED` or keep rows longer than `ANALYTICS_RETENTION_DAYS`. The
Settings tab shows what is asked for, the ceiling, and what applies. It warns
when retention is shorter than the dead-page window, because then the unread
and dead lists can never match.

### Retention

`AnalyticsRetentionSweeper` runs in the worker only (`AnalyticsWorkerModule`).
It ticks hourly, never runs twice at once, and deletes in batches of 5 000.
For each workspace it deletes rows past the effective retention, and nulls
`query_text` older than `ANALYTICS_QUERY_TEXT_DAYS`. `query_hash` survives,
so a redacted query still groups; the dashboard shows it as "redacted" with
its hash prefix.

### Query text is untrusted

A search query is user-authored text. Wherever it reaches a model,
`knowledge_list_search_gaps` hands it back through `wrapUntrusted(…, 'search')`.
The CSV export prefixes a cell starting with `=`, `+`, `-` or `@` with `'`, so
a spreadsheet does not run it.

## Decisions

- **Three classes, not two.** The issue drew human vs agent. An assistant
  turn is a model answering a person, which is neither, so it got its own
  class (`assisted`), and the chat bots joined it.
- **Anonymous only, for now.** A named mode (who read what) needs a consent
  story and a setting nobody has asked for yet, so there is no
  `ANALYTICS_READER_IDENTITY`.
- **Columns on `workspace_settings`**, not the planned
  `workspace_analytics_settings` table: that model is where milestone
  settings live, and the null-inherits rule is unchanged.
- **The view route is `POST /v1/documents/:id/views`**, not
  `/v1/analytics/views`, so `AclGuard` checks the page instead of a
  hand-written check.
- **Repeat searches collapse at read time.** A write-time dedupe would need
  state per reader. Read-time keeps every row, so the rule can change without
  a migration.
- **Coverage gaps are searches only.** Answer-level misses stay in
  `answer_feedback` ([feature 38](38-answer-provenance.md)).
- **MCP analytics calls are counted like any other.** The plan excluded them
  from the Agents tool ranking. That would make the tools list stop adding up
  to the MCP-calls tile, so they stay in.
- **`knowledge_list_search_gaps` needs an admin write key.** It is offered to
  read-only keys like every read tool, but a read key never reaches `admin`
  (feature 33), exactly as on `GET /v1/analytics/search`.

## Surface

### REST

| route | role | |
| --- | --- | --- |
| `POST /v1/documents/:id/views` | viewer (page) | open a web view; 204 |
| `POST /v1/analytics/views/:viewId/heartbeat` | the view's reader | active ms so far; 204 |
| `GET /v1/documents/:id/insights` | viewer (page) | 30 days of one page |
| `GET /v1/projects/:id/analytics?days=&traffic=` | editor (project) | totals, chart, three page lists |
| `GET /v1/analytics/{overview,pages,search,agents}?workspaceId=&days=&traffic=` | admin | the dashboard tabs |
| `GET /v1/analytics/export.csv?report=` | admin | one of `ANALYTICS_REPORTS`, up to 5 000 rows; audited as `analytics.export` |
| `GET` / `PUT /v1/analytics/settings` | admin | requested, ceiling and effective values |

`POST /v1/search` returns `searchId` when the search was recorded.

### MCP

| tool | role | |
| --- | --- | --- |
| `knowledge_get_page_insights` `{documentId}` | viewer (page) | the payload of `GET /v1/documents/:id/insights` |
| `knowledge_list_search_gaps` `{workspaceId, days?}` | admin | `zeroResult` and `noClick` query groups (100 each), wrapped untrusted |

Both are read tools: neither is in `WRITE_TOOLS`. Every MCP call, these
included, writes one `mcp_tool_calls` row with its tool, outcome, duration and
key.

### Web

`components/analytics/`: `DailyBars.vue` (lifted from `AiUsagePanel.vue`),
`PageInsightsWidget.vue` and `ProjectAnalyticsSection.vue`, plus
`pages/AnalyticsPage.vue` at `/analytics`. The nav item is admin-only, and the
route shows the forbidden state to anyone else.

## Operations

- Migration `20261116100000_usage_analytics` adds the three tables and the two
  `workspace_settings` columns. It is additive and survives a code rollback.
- Env vars, all with defaults:

  | var | default | |
  | --- | --- | --- |
  | `ANALYTICS_ENABLED` | `true` | `false` records nothing |
  | `ANALYTICS_READER_SECRET` | empty | falls back to a key derived from `SETTINGS_ENCRYPTION_KEY` |
  | `ANALYTICS_READ_TIME_CAP_MS` | `1800000` | one view's read-time ceiling |
  | `ANALYTICS_DEAD_PAGE_DAYS` | `90` | the dead-page window |
  | `ANALYTICS_RETENTION_DAYS` | `180` | ceiling on how long rows are kept |
  | `ANALYTICS_QUERY_TEXT_DAYS` | `90` | after this, `query_text` is nulled |

- Set `ANALYTICS_READER_SECRET` (or keep `SETTINGS_ENCRYPTION_KEY` stable).
  Changing it splits every reader in two from that moment on.
- Write cost: one insert per search, view and MCP call, and one guarded update
  every 15 s per open page.

## Deliberate deferrals

- **CSV is built in memory** up to 5 000 rows. Stream from a cursor if a
  workspace outgrows it (`ponytail:` marker in `analytics-query.service.ts`).
- **The sweeper deletes on `created_at`** with no index that leads on it
  (`ponytail:` marker). Add one if a sweep shows up in slow-query logs.
- No custom date ranges, no pagination past 100 rows on screen, and no
  per-person view of anything.
- Write amplification is unmeasured. If it shows, batch through a Redis list
  drained by a tick. Those would still be event rows, not aggregates.

## Verification

- Unit (`apps/api/test/`):
  - `analytics-recorder.spec.ts`: traffic classes and their inverse,
    `channelFor`, reader keys, DNT/GPC, and a failing write never throwing;
  - `analytics-dashboard.spec.ts`: the CSV encoder and its formula guard, the
    settings clamp, and the retention sweep;
  - `mcp-http.spec.ts`: one tool-call row per call, and the two tools' guards,
    read-key refusal and untrusted wrapper.

  Web: `lib/page-view.spec.ts` (hidden tabs pause the timer, `pagehide`
  flushes).
- e2e against live infra (`pnpm --filter @knowledge/api run test:e2e`, not in
  CI):
  - `analytics-beacon.e2e-spec.ts`: the guarded heartbeat;
  - `analytics-query.e2e-spec.ts`: rollups, scope and the read-signal filters;
  - `analytics-dashboard.e2e-spec.ts`: search collapse, CTR, agents and
    retention;
  - `analytics-flow.e2e-spec.ts`: the whole loop. A session searches and
    finds nothing, then opens a result (CTR counted with its rank). A `kn_`
    key searches over MCP (counted as agent, with its tool call). An admin key
    reads the gaps, wrapped untrusted.
