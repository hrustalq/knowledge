# 80 — Memory banks: a Hindsight-compatible memory for agents

> Milestone [#986](https://github.com/hrustalq/knowledge/issues/986): phases 0–5
> ([#987](https://github.com/hrustalq/knowledge/issues/987)–[#992](https://github.com/hrustalq/knowledge/issues/992)),
> observations ([#993](https://github.com/hrustalq/knowledge/issues/993)) and the web section, promote and this
> page ([#994](https://github.com/hrustalq/knowledge/issues/994)). Milestone
> [#1006](https://github.com/hrustalq/knowledge/issues/1006) (memory interop): verbatim retain and profile routing
> ([#1007](https://github.com/hrustalq/knowledge/issues/1007)), the graph wire
> ([#1008](https://github.com/hrustalq/knowledge/issues/1008)), the memory tool wire
> ([#1009](https://github.com/hrustalq/knowledge/issues/1009)), and their web tabs and this page's sections on them
> ([#1010](https://github.com/hrustalq/knowledge/issues/1010)).

## What

An agent connected to the platform could read pages and propose changes to them, but had
nowhere to keep what it learns for itself between sessions. A capture opens a merge request:
right for shared knowledge, wrong for working memory, which has to be readable the moment it
is written.

The rule: **a memory is a row an agent wrote for itself: live at once, readable only through
its bank, never a page and never in page search. A bank belongs to one workspace. Anything
that should become shared knowledge leaves through the capture → merge request path.**

**A bank is one store with several wires.** Each wire keeps its interface exactly — tool names,
schemas, answer strings, error strings — and underneath is the same bank, resolved by the same
`MemoryAccessService`. What any wire writes, Hindsight `recall` on that bank finds.

| Wire | Where | Reference it matches |
| --- | --- | --- |
| Hindsight | `/v1/default/banks/{bank_id}/…`, `/mcp/{bank_id}/` | [Hindsight](https://github.com/vectorize-io/hindsight) OpenAPI v1.2.1, core routes only |
| Knowledge graph | `/mcp/{bank_id}/graph` | the MCP reference memory server, `@modelcontextprotocol/server-memory` 2.1.1 |
| Memory files | `POST /v1/default/banks/{bank_id}/memory-tool`, `/mcp/{bank_id}/files` | Anthropic's memory tool (`memory_20250818`) and the SDK's `BetaLocalFilesystemMemoryTool` (`@anthropic-ai/sdk` 1.8.0) |

"Compatible" is defined by tests that run the reference and this API side by side:
`apps/api/test/hindsight-compat.e2e-spec.ts` (the official `@vectorize-io/hindsight-client`),
`memory-graph-compat.e2e-spec.ts` (the reference server over stdio on a temporary file) and
`memory-files-compat.e2e-spec.ts` (the SDK's filesystem handler on a temporary directory). No model
is called by any of them. Every other Hindsight route answers 404. Where this server differs from a
reference, the difference is listed under that wire below.

## Switching it on

Off by default, twice:

- `MEMORY_ENABLED` (env, default `false`) is the server's ceiling. Off, every memory route
  answers 404 and no memory table is written.
- `memory` is a workspace section, on unless an admin switched it off — under Settings → Features,
  or with the switch at the top of Settings → Memory banks.

The worker must have started once: it creates the `MemoryUnit` vector type and its index in
ArcadeDB on boot. Without the index a retain answers 503 and says so.

## Connecting a client

Production forwards `/api/*` to the API, so a client's base URL is `https://<host>/api`.
The key must be **pinned to one workspace**: the literal `default` in
`/v1/default/banks/...` means that workspace. A key with no pin gets a 400; a key limited to
MCP toolsets is refused on every memory route.

```ts
import { HindsightClient } from '@vectorize-io/hindsight-client';

const memory = new HindsightClient({ baseUrl: 'https://<host>/api', apiKey: 'kn_…' });
await memory.retain('my-agent', 'Alice works at Google as a software engineer');
const { results } = await memory.recall('my-agent', 'What does Alice do?');
const { text } = await memory.reflect('my-agent', 'What does Alice do?');
```

Over MCP, one endpoint per bank:

```bash
# Claude Code
claude mcp add --transport http memory https://<host>/api/mcp/my-agent/ \
  --header "Authorization: Bearer kn_…"
```

```json
{
  "mcpServers": {
    "memory": {
      "url": "https://<host>/api/mcp/my-agent/",
      "headers": { "Authorization": "Bearer kn_…" }
    }
  }
}
```

`https://<host>/api/mcp` with an `X-Bank-Id` header is the same server without a bank in the
URL; its tools also take an optional `bank_id`, and it adds `list_banks`. The header form is
Hindsight-only: `/mcp/graph` already means "the bank named graph".

A profile after the bank picks the wire: `/mcp/{bank_id}/hindsight` (the same as the bare path),
`/mcp/{bank_id}/graph` and `/mcp/{bank_id}/files`; any other name is a 404 (`MEMORY_MCP_PROFILES`
in `memory-mcp.ts`). An application backing Claude's memory tool needs no MCP at all: it posts each
`tool_use.input` to `POST https://<host>/api/v1/default/banks/{bank_id}/memory-tool` and hands the
answer back as the tool result.

```ts
import { betaMemoryTool } from '@anthropic-ai/sdk/helpers/beta/memory';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';

async function forward(input: unknown): Promise<string> {
  const res = await fetch('https://<host>/api/v1/default/banks/my-agent/memory-tool', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.KNOWLEDGE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`memory bank answered ${res.status}`);
  const { content, is_error } = (await res.json()) as { content: string; is_error: boolean };
  if (is_error) throw new ToolError(content); // the SDK runner sends it back verbatim, with is_error
  return content;
}

export const memory = betaMemoryTool({ view: forward, create: forward, str_replace: forward, insert: forward, delete: forward, rename: forward });
```

Settings → Memory banks shows these URLs for the server it runs on, with the same handler in
Python (which answers the `tool_use` block by hand and needs no SDK helper).

**Clients that start only local (stdio) servers** — the reference memory server is stdio-only, so
many configs expect a command — connect through [`mcp-remote`](https://github.com/geelen/mcp-remote):
`npx mcp-remote <url> --header "Authorization: Bearer …"`. No stdio entrypoint is shipped. Put the
space of `Bearer …` in env, not in args, because several hosts split args on spaces:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://<host>/api/mcp/my-agent/graph", "--header", "Authorization:${AUTH_HEADER}", "--transport", "http-only"],
      "env": { "AUTH_HEADER": "Bearer kn_…" }
    }
  }
}
```

Under `AUTH_MODE=none` there is no key to read a workspace from, so the workspace is named by
an `X-Workspace-Id` header.

## Routes

| Route | Role | |
| --- | --- | --- |
| `GET /version`, `GET /health` | public | the probes a client sends first; 404 while memory is off |
| `GET /v1/default/banks` | viewer | the banks the caller may read |
| `PUT`, `PATCH`, `DELETE /v1/default/banks/{bank_id}` | editor | create or update, update, delete |
| `GET`, `PUT …/profile` | viewer, editor | name, mission, disposition |
| `POST …/memories` | editor, `capture` key | retain; `async: true` returns an `operation_id` |
| `POST …/memories/recall` | viewer | recall |
| `POST …/reflect` | viewer | one answer over a recall |
| `GET …/memories/list`, `GET …/memories/{id}`, `GET …/stats` | viewer | |
| `DELETE …/memories` | editor | every memory, or one fact type |
| `GET`, `PATCH …/config` | viewer, editor | `enable_observations`, `reflect_mission`, the three disposition traits; any other key is a 400 that names the ones kept |
| `POST …/consolidate` | editor | one consolidation pass as an operation; 409 with the reason while consolidation cannot run |
| `GET …/operations`, `GET …/operations/{id}` | viewer | an id the bank does not hold reads `not_found` |
| `DELETE …/operations/{id}` | editor | cancel a pending one |
| `POST /mcp/{bank_id}/`, `POST /mcp` | per tool | `retain`, `sync_retain`, `recall`, `reflect` (+ `list_banks`); `/mcp/{bank_id}/hindsight` is the same server |
| `POST /mcp/{bank_id}/graph` | per tool | the reference memory server's nine tools; see [The knowledge graph wire](#the-knowledge-graph-wire) |
| `POST /mcp/{bank_id}/files`, `POST …/memory-tool` | per command | the memory tool's six commands; see [The memory files wire](#the-memory-files-wire) |

Errors under these paths leave as `{"detail": …}`, FastAPI's shape, including an unmatched
route and a body-parser error; a failed validation is a 422 with one entry per violation.
None of these routes is in `openapi.json`, the generated web client or the docs reference.

## How a request is resolved

`MemoryAccessService` (`apps/api/src/memory/`) is the one place a memory request becomes a
workspace and a bank; every route and every MCP tool asks it, on execution:

1. `MEMORY_ENABLED` off → 404.
2. The workspace is the key's pin (`X-Workspace-Id` in dev mode); none → 400.
3. `AccessService.requireRole`: membership, the role, what the key narrows. A read-only key
   never retains; a `capture` key is lifted to editor for retain and nothing else.
4. The workspace's `memory` section → 404 when off.
5. A bank bound to a project (`memory_banks.project_id`) follows that project's restriction
   (`canSeeProject`): hidden, as a 404, from whoever cannot see the project. Guests get nothing.

## Storage

Postgres holds the truth: `memory_banks`, `memory_units`, `memory_unit_entities`,
`memory_operations`, for observations `memory_observation_evidence` and
`memory_observation_history`, for the graph wire `memory_entities` and `memory_relations`, and for the
files wire `memory_files` — all cascading from the bank and filed in the workspace teardown inventory. ArcadeDB holds only the vector, as a third vector type (`MemoryUnit`)
beside `Chunk` and `ChatChunk`. A vector is written before its row; recall loads the final
rows from Postgres by id, workspace and bank, so an orphan vector is never served, and the
worker's `MemoryReapSweeper` removes it. Deleting a bank or a workspace removes its rows and
its vectors.

Memory entities use the canonical key format (`normalizeEntityKey`, resolved through
`entity_aliases`) but are rows only: no vertex and no edge is written to the workspace
relation graph.

## Retain

`MemoryRetainService`, for both doors: the API runs it inside a sync request, the worker for
an async one.

- **Masked first** with the chat masker (`common/mask.ts`): secrets, addresses, phone and
  identity numbers become placeholders before a model or a store sees the text.
- **Facts are extracted** by the `memorist` agent (purpose `extraction`) when a model is
  routed there and the budget allows. A missing route, a spent budget, a failed call or an
  unreadable answer stores the masked text verbatim: retain never fails for want of a model.
- **A `document_id` retained before is replaced** (`update_mode: append` keeps it).
- **Async**: the items are stored, masked, in a `memory_operations` row whose id is the
  client's `operation_id` when it sent one; the job carries only the id. An API-side sweeper
  re-enqueues a job the queue lost, re-queues or fails a row a dead worker left claimed, and
  purges finished rows after `MEMORY_OPERATION_RETENTION_DAYS`.

**Verbatim retain** (#1007): a wire whose interface stores exactly what it was given sets
`RetainInput.verbatim`, which skips the `memorist` and stores one unit per item, still masked and
embedded; `consolidated` writes the units with `consolidated_at` already set, so consolidation never
claims them. Both wires below write through `MemoryIntakeService` (`admit` → rows of their own →
`store`), so the retain rate, the ceilings and the bank's creation are the same as a retain's.

## Recall and reflect

Recall fuses four legs with `fuseHits` (`search/ranking.ts`): nearest vectors, `tsvector`
rank over any of the query's words, memories sharing an entity with the best hits, and the
occurred span when the request gives a `temporal_window`. A tag or type filter is decided in
Postgres first and handed to every leg. Results are cut to `max_tokens` by an estimate
(~4 characters a token), best first. `rerank.prune` asks the decision model only when one is
routed. There is no cross-encoder reranker: `min_scores.reranker` is a 400.

Reflect is one recall and one model call by the `reflector` agent (purpose `chat`). The
bank's mission and disposition are trusted lines of the system prompt; the recalled memories
reach the model only inside `wrapUntrusted`, as they do in the MCP `recall` tool's result.
With no model configured reflect answers 409 and bills nothing.

## Observations

A bank's facts are folded, in the background, into **observations**: one durable statement, the
facts that support it and a quote from each (`memory_observation_evidence`). An observation is a
`memory_units` row of type `observation`, with its own vector, so recall ranks it like any memory.
Its proof count is its evidence rows, derived on read and never stored.

- **Who does it.** The `consolidator` agent (purpose `extraction`), one JSON call per batch of up to
  ten facts, from `MemoryConsolidationService`. The worker runs it: `MemoryConsolidationSweeper`
  makes one call per bank per minute for every bank with facts waiting, and `POST …/consolidate`
  queues a pass of up to ten calls as an operation row (`type: consolidation`, the same queue,
  processor and stale-row sweeper as an async retain).
- **When it runs.** Only while a model is routed to the consolidator — the extraction route or a pin
  on the agent, never the inline or env model — the bank has not set `enable_observations: false`
  (null inherits on), the workspace budget has room (`assertWithinBudget`, billed to no person as the
  learner's coach is), and the bank is under its daily cap. Each is checked before the call it would
  pay for; a pass that stops says which (`disabled`, `no-model`, `cap`, `budget`, `failed`). With no
  model routed nothing is claimed and nothing is called: recall behaves as it did before observations.
- **The daily cap** is `MEMORY_CONSOLIDATION_DAILY_CALLS` per bank per UTC day, taken by one guarded
  `UPDATE` of `memory_banks.consolidation_day` / `consolidation_calls` before each call, so two workers
  never pass it. The backlog waits for the next day. Decision-model screens do not count against it.
- **Claimed once.** Facts are claimed with one `UPDATE … WHERE id IN (… FOR UPDATE SKIP LOCKED)` on
  `consolidation_claimed_at`, one tag scope at a time (the oldest pending fact's exact tag set), so two
  workers never read the same facts and an observation never mixes facts filed under different tags.
  A claim older than ten minutes is a dead worker's and is taken over; a stopped or failed batch
  releases its claim. A fact the consolidator has read gets `consolidated_at`, whether or not it
  became evidence.
- **Candidates.** For each fact, the nearest observations of the same scope by vector (five each,
  twenty in all). When a decision model is routed, each fact–observation pair is screened first
  (site `memory` in `DECISION_SITES`, operation `memory-consolidate-screen`): an observation stays
  when any pair clears the threshold, or a question fails. A pre-filter, never a verdict.
- **The answer is a claim.** `readConsolidation` (pure, `memory-observations.ts`) keeps evidence only
  under a fact label it handed out and only with a quote **verbatim** in that fact; an entry left with
  no evidence is dropped, as is a label never handed out or a second refine of one observation.
- **Refine, never overwrite.** New wording for an existing observation writes its old text to
  `memory_observation_history` first (`refinement`); evidence is only ever added. Writes happen under
  the bank's lock, against the observation's text as it is then, not as the model saw it.
- **Deleting a fact** removes it from every observation's evidence (FK cascade); an observation left
  with none is deleted in the same transaction (`MemoryUnitsService.deleteBareObservations`), on every
  path that deletes facts: a re-retained `document_id`, `DELETE …/memories`, the web delete. A retain's
  `document_id` replacement never touches an observation.
- **Untrusted both ways.** The facts and the candidate observations reach the model only inside
  `wrapUntrusted`; the bank's mission is the one trusted line.

Recall returns observations when `types` includes `observation` (no `types` = all), each with
`source_fact_ids`. `prefer_observations` drops a raw fact that a returned observation stands on and
backfills the freed room (`preferObservations`); `include.source_facts` returns those facts, loaded
from the bank, within `max_tokens` (default 4096) and `max_tokens_per_observation`, with
`source_facts_truncated` when the budget cut the map. The entity map lists the returned observations
that name each entity. `GET …/memories/list` reports an observation's `proof_count` and
`source_memory_ids`; `…/stats` its `pending_consolidation` (facts not yet read, whether or not a model
is routed). `/version` reports `observations` and `bank_config_api` true.

## The knowledge graph wire

`/mcp/{bank_id}/graph` (#1008) serves the nine tools of `@modelcontextprotocol/server-memory` 2.1.1 —
`create_entities`, `create_relations`, `add_observations`, `delete_entities`, `delete_observations`,
`delete_relations`, `read_graph`, `search_nodes`, `open_nodes` — with the reference's names, titles,
descriptions, input and output schemas, annotations and answer strings (`memory-graph-mcp.ts`; the
pure rules and strings in `memory-graph.ts`, the rows in `MemoryGraphService`). The differential test
compares `tools/list` and every step's `isError`, `content` and `structuredContent` with no
re-sorting, because the reference fixes every order.

- **Storage.** An entity is a `memory_entities` row (exact name, unique per bank; type; the folded
  `normalizeEntityKey(name)` as the link to recall's entity leg) and a relation a `memory_relations`
  row (from, to, type, unique per triple). Both carry a SERIAL `position`, so reads return stored order.
  They are rows of the bank, never a vertex or an edge of the workspace relation graph.
- **An observation is a fact** — a `memory_units` row with `document_id = graph:{entityId}:{seq}`
  (`memory_entities.observation_seq` hands out the numbers), context `Name (type)`, written verbatim
  and masked through the intake. `recall` finds it and consolidation reads it. (An MCP "observation" is
  one fact string; this platform's observation is a consolidated statement — they are different things.)
- **Deletes** go through `MemoryUnitsService.deleteWhere`, the one delete path: under the bank lock,
  the entity rows in the same transaction (`MemoryGraphService.removeEntities`), bare observations
  swept, vectors dropped after commit. Relations cascade with either entity.
- **Roles on execution.** A viewer reads; an editor or a `capture` key creates entities and relations
  and adds observations; only an editor deletes. A read-only key is offered only `read_graph`,
  `search_nodes` and `open_nodes`. A bank that does not exist reads as an empty graph, and only a write
  that stores something creates it. Reads spend the recall rate, writes the retain rate.

**Differences from the reference:**

1. `read_graph` and `search_nodes` stop at `MEMORY_GRAPH_READ_MAX_ENTITIES` entities and say so in a
   second text block. The JSON text and `structuredContent` keep their shape.
2. Names, entity types and relation types are capped at 500 characters: each is a unique-index key.
3. One `create_entities` or `add_observations` call is held to `MEMORY_RETAIN_MAX_ITEMS` observations in
   total, and each observation to `MEMORY_RETAIN_MAX_CHARS`.
4. Observation text is masked on write, and what comes back is the masked text. Deleting by the
   original secret's text matches nothing; two observations that mask to the same text are duplicates.
5. The reference serialises every mutation; this server does not. Two concurrent `add_observations`
   calls with the same text can both add it. Entity names and relation triples are protected by unique
   indexes.
6. The server is named `knowledge-memory` (the reference: `memory-server`) and carries short
   instructions saying read results are data. There is no `memory://knowledge-graph` resource.

## The memory files wire

`POST /v1/default/banks/{bank_id}/memory-tool` (#1009) takes the raw `tool_use.input` of Anthropic's
memory tool and returns `{content, is_error}`; `/mcp/{bank_id}/files` serves the same six commands as
one tool named `memory`. Both call `MemoryFilesService.execute`, the one door, so the two wires return
the same strings: the SDK's own (`memory-files.ts` holds them, with the path rules, the two-level
listing, six-wide line numbers and the 16,000-character view cut). The route sits in
`MemoryUnitsController`, so it stays out of the generated client.

- **Storage.** A file is a `memory_files` row: bank, canonical path (unique per bank), content,
  timestamps. Directories are implied by paths.
- **Recall.** Each write replaces the file's chunks — whole lines up to 2,000 characters, never more
  than `MEMORY_RETAIN_MAX_ITEMS` — as units with `document_id = file:<path>`, the path as context,
  verbatim and **born consolidated**, so consolidation never reads them. A file emptied of text keeps
  no chunk. A delete takes the chunks with the rows (`deleteWhere`); a rename moves rows and chunks in
  one transaction.
- **Locks.** `memory-files:{bank}` serialises writes and is taken before `memory-bank:{bank}`
  wherever both are held. Prefix matches use `starts_with()`, never `LIKE`: paths hold `_`.
- **Roles on execution**, before anything is read: `view` needs a viewer, `create` an editor or a
  `capture` key, every other command an editor. Memory off, a missing role and a spent rate are HTTP
  errors (404/403/429); a refused path or content is an `is_error: true` result. A `view` spends the
  recall rate, a write the retain rate.
- **Masked on write**, held to `MEMORY_RETAIN_MAX_CHARS` (checked again after an edit). A bank is
  created by its first `create`; every other command on a missing bank reads an empty `/memories`,
  whose root listing is not an error.

**Differences from `BetaLocalFilesystemMemoryTool`:**

1. `create` on an existing file overwrites it, as the documentation allows and Claude's tool
   description ("creates or overwrites") says. The SDK refuses.
2. Any `..` segment is refused — including one that would resolve inside `/memories`
   (`/memories/a/../b`), a URL-encoded one (decoded repeatedly, so `%252e%252e` counts) and one using
   `\` as the separator. `/memoriesX/…` is outside `/memories`; the SDK maps it inside. Control
   characters and canonical paths over 1,024 characters are refused.
3. Directories are implied: an emptied directory is gone, and every directory lists as `4.0K`. A file
   cannot sit under a file (`Cannot write X: Y is a file`).
4. A file view stops at a whole line past 16,000 characters and appends
   `[Truncated: … Use view_range to read from line N.]`. Claude's tool description promises the cut; the
   SDK has none.
5. `str_replace` also matches an `old_str` spanning lines, which the SDK's per-line match never finds.
   Without a newline the two agree, two hits on one line included. An omitted `new_str` deletes
   `old_str`, as the documentation says; the SDK writes "undefined".
6. `.png`, `.jpg` and `.jpeg` are refused on view, on create and as a file's rename target:
   `X is an image file. This memory store holds text files only`.
7. Over MCP `command` is an enum, so an unknown command is an MCP input-validation error rather than
   `Error: <x> not implemented`. REST gives the SDK's string.
8. Own messages where the SDK would leak a raw errno: moving a directory into itself, a size over the
   cap, a field of the wrong type.

Known gaps: the recall index is written after the file row commits, so an index failure (no
embeddings, store not ready) is logged and the command still succeeds, and recall lags until that
file's next write — two concurrent writes of one file can leave it one write behind. `DELETE
…/memories` removes file chunks but keeps the files; the next write re-indexes each. A rename keeps
each chunk's vector, embedded with the old path as context.

## The web section

**Settings → Memory banks** (`apps/web/src/modules/memory/`), on this platform's own routes:

| Route | Role | |
| --- | --- | --- |
| `GET /v1/memory/banks?workspaceId=` | viewer | the banks the caller may read, with fact and observation counts, last write, `apiUrl` (`API_PUBLIC_URL`) and whether consolidation can run |
| `GET /v1/memory/banks/:id/memories` | viewer | a bank's memories, newest first; `type`, `q`, `limit` (≤ 200), `offset` |
| `PATCH /v1/memory/banks/:id` | editor | bind to a project or the whole workspace; needs `requireProjectManage` on the project it leaves and the one it joins |
| `DELETE /v1/memory/banks/:id?confirm=<bank id>` | editor | the bank and everything in it; the typed id is checked again here |
| `DELETE /v1/memory/banks/:id/memories/:memoryId` | editor | one memory, and any observation it leaves bare |
| `POST /v1/memory/banks/:id/memories/:memoryId/promote` | editor | see below |
| `GET /v1/memory/banks/:id/entities` | viewer | the graph's entities in creation order, each with its observations (id + text), and every relation touching one; `q` (name, type or observation text), `limit` (≤ 200), `offset` |
| `DELETE /v1/memory/banks/:id/entities/:entityId` | editor | one entity, its observations and every relation touching it (`MemoryGraphService.removeEntities`) |
| `DELETE /v1/memory/banks/:id/relations/:relationId` | editor | one relation; both entities stay. An observation deletes through the memories route: it is a fact |
| `GET /v1/memory/banks/:id/files` | viewer | the memory tool's files by path, with size in bytes, without their text; `q` (path), `limit`, `offset` |
| `GET /v1/memory/banks/:id/files/:fileId` | viewer | one file's text as stored (masked) |
| `DELETE /v1/memory/banks/:id/files/:fileId` | editor | one file and its recall chunks, under the files lock (`MemoryFilesService.removeFile`) |

`:id` is the bank's row id, resolved to its workspace in PG first (`@Access` source `memory-bank`);
a bank bound to a project the caller cannot see is a 404 from `MemoryWebService`. All of them carry
`@Feature('memory')`, so they 404 with the section off or `MEMORY_ENABLED` off, and they are in the
OpenAPI document and the generated client — unlike the Hindsight routes, which stay out of both.

The section hides its nav row while the server has memory off and, reached directly, says so instead
of showing a switch. It carries no `meta.feature`: an admin who switched the section off comes back
here to switch it on (everyone else is told it is off). A bank's page does carry it.

The section shows how to connect, for every wire: the Hindsight base URL, the three MCP endpoints, the
memory tool endpoint with a handler to paste (TypeScript and Python, `model/connection.ts`) and the
`mcp-remote` config for stdio-only clients; then the banks, with delete (the bank id typed). A bank's
page has three tabs (`?tab=entities|files` opens one; an opening instruction, not two-way state):

- **Memories** — facts and observations, with delete, promote and the project binding for editors.
- **Entities** — each entity with its type, its observations and its relations; delete of an entity
  (confirmed), an observation or a relation for editors.
- **Files** — by path, with size and last write; a file opens in place to its text. Delete (confirmed)
  for editors.

Everything a bank holds is agent-written from sources nobody reviewed: memories, observations, entity
names and file contents are shown as plain text, never rendered markdown. Editing a file or an entity
in the UI is not built; the wires are the only writers.

## Promote to a page

`POST …/memories/:memoryId/promote` (`{ projectId, title, kind }`, kind `gotcha` | `convention` |
`howto`) hands the memory to `CaptureService.capture` as a note whose body is the memory's text and
whose `appliesTo` is its entity keys. It is an ordinary capture from there: the capture switch, the
project and secret checks, the rate limits and the dedupe all apply, and it arrives as a merge request
with `provenance: 'captured'`. The origin is server-set, never a request field:
`{ platform: 'memory', chatTitle: <bank>, from, to }` (`MEMORY_ORIGIN_PLATFORM`), so the merge
request and the Captures inbox name the bank. The memory stays in the bank. API-only: the worker never
reaches `apps/api/src/captures/`.

## Environment

| Variable | Default | |
| --- | --- | --- |
| `MEMORY_ENABLED` | `false` | the ceiling over the workspace `memory` section |
| `MEMORY_RETAIN_MAX_ITEMS` | `100` | items one retain request may carry |
| `MEMORY_RETAIN_MAX_CHARS` | `50000` | characters one item may hold |
| `MEMORY_RETAIN_RATE_PER_MIN` | `120` | retain requests a key may send a minute |
| `MEMORY_RECALL_RATE_PER_MIN` | `300` | recall requests a key may send a minute |
| `MEMORY_REFLECT_RATE_PER_MIN` | `30` | reflect requests a key may send a minute; refused when the limiter is unreachable |
| `MEMORY_OPERATION_TIMEOUT_MS` | `600000` | when a claimed async retain counts as lost |
| `MEMORY_OPERATION_RETENTION_DAYS` | `7` | how long a finished operation's row is kept |
| `MEMORY_CONSOLIDATION_DAILY_CALLS` | `20` | consolidation calls one bank may make a UTC day; `0` turns observations off for the server |
| `MEMORY_GRAPH_READ_MAX_ENTITIES` | `500` | entities one `read_graph` or `search_nodes` returns before it says it cut |

## Not built

Hindsight's mental models, knowledge-base pages, directives, webhooks, transfer and clone,
bank templates, file retain, aliases, audit and LLM-request logs; its reflect tool loop and
`trace`; `tag_groups`; a recall tool for this platform's own assistant and agents; Hindsight's
observation scopes and consolidation strategies (`observation_scopes` on `POST …/consolidate` is not
read: every pass keeps each exact tag set to itself) and its bank config keys beyond the five above;
consolidating across banks; editing a memory's text, a file or an entity in the UI, a graph view of
memory entities, usage charts per bank. For the other wires: a stdio entrypoint or a published package;
importing an existing `memory.jsonl` or a local `/memories` folder; the reference server's
subscribable `memory://knowledge-graph` resource; Managed Agents memory stores, mem0, Zep, Letta;
file conventions such as Cline's `memory-bank/` or `CLAUDE.md`.
