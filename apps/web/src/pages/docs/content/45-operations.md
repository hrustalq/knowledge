---
title: Running it
section: Administration
summary: The services, the environment variables that change behaviour, and what to check when something is stuck.
---

# Running it

## The services

| Service | Port | Holds |
| --- | --- | --- |
| API | 3000 | REST + Swagger at `/docs` |
| Web | 5173 | the SSR app |
| Worker | — | ingestion, imports, workflows, connectors, agents |
| PostgreSQL | 5432 | transactional truth |
| MinIO | 9000 / 9001 | raw bytes, versioned |
| Redis | 6379 | BullMQ queues and the event bus |
| ArcadeDB | 2480 | graph and vectors |
| OpenSearch | 9200 | optional BM25 (`make infra-up-opensearch`) |

The API, the worker and the MCP server are **three entrypoints of the same application** —
same modules, different composition. A fourth exists only to emit the OpenAPI document.

## Environment worth knowing

| Variable | Effect |
| --- | --- |
| `AUTH_MODE` | `none` (open dev principal) or `api-key` |
| `EMBEDDINGS_PROVIDER` | `stub` or `openai-compatible` (+ `EMBEDDINGS_BASE_URL` ending in `/v1`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIM`) |
| `EXTRACTOR_PROVIDER` | `none` or `openai-compatible` — LLM relation extraction, with `EXTRACTOR_MIN_CONFIDENCE` |
| `ASSISTANT_PROVIDER` | `none`, `openai-compatible`, `deepseek`, `gen-api` |
| `FULLTEXT_PROVIDER` | `none` or `opensearch` |
| `SETTINGS_ENCRYPTION_KEY` | required to store provider credentials |
| `MR_REQUIRED_APPROVALS` | merge gate, default 1, author excluded |
| `STALE_*` | the reindex sweeper's timeouts and retry cap |
| `DEPENDENT_REINDEX_MAX` | cap on the one-level reindex cascade |
| `LIVE_WS_ENABLED`, `LIVE_TRACKED_EVENTS` | the live-update WebSocket and what it fans out |
| `WORKFLOW_AUTOSTART_MAX_ACTIVE` | how many auto-started runs may be in flight |
| `CONNECTOR_*`, `AGENT_SCHEDULE_ENABLED` | sync limits and background agent scheduling |

`make env-check` compares your `.env` files against `.env.example` — run it after pulling.

## Migrations

```bash
make db-migrate-new name=<x>    # create and apply
make db-migrate-deploy          # apply committed migrations only (prod-style)
make db-reset                   # DESTRUCTIVE: drop, replay
```

A migration adding a **NOT NULL column to a populated table** cannot be expressed by
`migrate dev`, which applies immediately. Create it with `--create-only`, hand-edit the SQL
to add the column nullable → `UPDATE` → `SET NOT NULL`, then apply.

## When something is stuck

**A page never reaches `indexed`.** Check the worker is running (`make dev-worker`), then
`GET /v1/ingestion/jobs/:id`. The sweeper retries `failed` jobs under
`STALE_MAX_ATTEMPTS`; past that it stops so a poison message cannot loop forever.

**Search returns nothing sensible.** With `EMBEDDINGS_PROVIDER=stub` it never will — the
vectors are hashes. Point it at a real embedder and let the drift sweeper reindex.

**Keyword mode behaves like semantic.** No `FULLTEXT_PROVIDER=opensearch`, so it fell back
by design.

**A merge is refused.** Read the reason: `draft`, `approvals`, `diverged`, or a protected
branch. A `diverged` response links to the comparison.

**AI features are absent rather than failing.** `ASSISTANT_PROVIDER=none`. The UI reports
disabled instead of erroring at request time.

**The API answers 403 where you expected 401.** 401 is authentication, 403 is
authorization — the workspace was resolved and the role was insufficient.
