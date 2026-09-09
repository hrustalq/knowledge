---
title: Quickstart
section: Getting started
summary: From a clean checkout to a page you can search, in six commands.
---

# Quickstart

## Bring it up

```bash
make setup      # env files → pnpm install → infra containers → migrations → build
make dev        # infra + api :3000 + web :5173 + ingestion worker, all in watch mode
```

`make help` lists every target. `make smoke` health-checks all six services and tells you
which one is missing:

```
✔ api      :3000/docs
✔ web      :5173
✔ arcadedb :2480
✔ minio    :9000
✔ postgres :5432
✔ redis    :6379
```

Out of the box `AUTH_MODE=none` and `EMBEDDINGS_PROVIDER=stub`, which means no login and
no external API keys: the stub embedder produces deterministic vectors from a hash, so the
entire pipeline — upload, index, search, graph — runs end to end with nothing but Docker.
Search results are nonsense, but every moving part is real.

## Put a page through the pipeline

The write path has three calls because the bytes never pass through the API:

```bash
# 1. create the document (a project id is required — every page lives in one)
curl -s localhost:3000/v1/documents -H 'content-type: application/json' -d '{
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "projectId":   "<project-id>",
  "title":       "Identity service"
}'

# 2. ask for a presigned upload URL, then PUT the markdown straight at MinIO
curl -s localhost:3000/v1/documents/<id>/uploads -X POST \
  -H 'content-type: application/json' -d '{"contentType":"text/markdown"}'
curl -X PUT --data-binary @page.md '<presigned-url>'

# 3. finalize: hashes the bytes, creates the revision, queues indexing — one transaction
curl -s localhost:3000/v1/documents/<id>/revisions/<revisionId>/finalize -X POST
```

Then poll the revision until its status reaches `indexed`, and search:

```bash
curl -s localhost:3000/v1/search -H 'content-type: application/json' -d '{
  "workspaceId": "11111111-1111-4111-8111-111111111111",
  "query": "how does identity issue tokens"
}'
```

The web app does exactly this — `/create` and `/upload` are the same three calls with a
UI in front of them.

## Everyday targets

```bash
make check              # lint + typecheck + build — the gate CI runs
make kill               # kill this repo's dev processes (kill-all also stops infra)
make dev-worker         # only the BullMQ ingestion worker
make dev-mcp            # the MCP server on stdio, for agent clients
make db-migrate-new name=<x>   # create and apply a named Prisma migration
make api-client         # regenerate openapi.json → typed web client → docs reference
make auth-bootstrap email=<e>  # mint a user + API key + membership (AUTH_MODE=api-key)
```

There is no test suite. Verification is `make check` plus the loop above: upload,
finalize, poll for `indexed`, search.

## Turning on the real thing

Three switches take it from demo to useful, and each one is a provider swap rather than a
code change:

| Env | From | To |
| --- | --- | --- |
| `EMBEDDINGS_PROVIDER` | `stub` | `openai-compatible` (OpenAI, Ollama, LM Studio, vLLM — `EMBEDDINGS_BASE_URL` must end in `/v1`) |
| `ASSISTANT_PROVIDER` | `none` | `openai-compatible`, `deepseek`, `gen-api` — turns on the assistant, agents and AI authoring |
| `AUTH_MODE` | `none` | `api-key` — real users, sessions, roles and ACL enforcement |

Changing the embedding provider changes the vectors, which the platform notices: each
revision records the `provider:model:dim` signature it was indexed with, and a sweeper
reindexes branch heads whose signature has drifted.
