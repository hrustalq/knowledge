# 80 — Memory banks: a Hindsight-compatible memory for agents

> **Draft.** Written with phases 0–5 of milestone
> [#986](https://github.com/hrustalq/knowledge/issues/986)
> ([#987](https://github.com/hrustalq/knowledge/issues/987)–[#992](https://github.com/hrustalq/knowledge/issues/992)).
> Observations ([#993](https://github.com/hrustalq/knowledge/issues/993)) and promote-to-page,
> the web section and the finished doc ([#994](https://github.com/hrustalq/knowledge/issues/994))
> are not built yet; this page is completed with them.

## What

An agent connected to the platform could read pages and propose changes to them, but had
nowhere to keep what it learns for itself between sessions. A capture opens a merge request:
right for shared knowledge, wrong for working memory, which has to be readable the moment it
is written.

The rule: **a memory is a row an agent wrote for itself: live at once, readable only through
its bank, never a page and never in page search. A bank belongs to one workspace. Anything
that should become shared knowledge leaves through the capture → merge request path.**

The wire is [Hindsight](https://github.com/vectorize-io/hindsight)'s (OpenAPI v1.2.1), for
the routes below, so tools that already have a memory slot connect with no code of their own.
"Compatible" is defined by a test: the official `@vectorize-io/hindsight-client` runs
`apps/api/test/hindsight-compat.e2e-spec.ts` against this API. Every other Hindsight route
answers 404.

## Switching it on

Off by default, twice:

- `MEMORY_ENABLED` (env, default `false`) is the server's ceiling. Off, every memory route
  answers 404 and no memory table is written.
- `memory` is a workspace section (Settings → Features), on unless an admin switched it off.

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
URL; its tools also take an optional `bank_id`, and it adds `list_banks`.

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
| `GET …/operations`, `GET …/operations/{id}` | viewer | an id the bank does not hold reads `not_found` |
| `DELETE …/operations/{id}` | editor | cancel a pending one |
| `POST /mcp/{bank_id}/`, `POST /mcp` | per tool | `retain`, `sync_retain`, `recall`, `reflect` (+ `list_banks`) |

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
`memory_operations`. ArcadeDB holds only the vector, as a third vector type (`MemoryUnit`)
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

## Not built

Hindsight's mental models, knowledge-base pages, directives, webhooks, transfer and clone,
bank templates, file retain, aliases, audit and LLM-request logs; its reflect tool loop and
`trace`; `tag_groups`; a recall tool for this platform's own assistant and agents.
