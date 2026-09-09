---
title: The ingestion pipeline
section: Concepts
summary: How bytes become a searchable page — the outbox, the worker's eight steps, and why running it twice is harmless.
---

# The ingestion pipeline

## The write path

```
POST /v1/documents                     create the row (project + title)
POST /v1/documents/:id/uploads         presigned PUT URL
PUT  <presigned url>                   bytes go straight to MinIO — never through the API
POST .../revisions/:rev/finalize       hash → dedupe → revision → job   ← one transaction
                                       ↓
                                    BullMQ
                                       ↓
                                  the worker
```

The API never streams a file body. That is a deliberate constraint: a 300-page PDF or a
50 MB attachment would otherwise occupy a request handler for its entire transfer.

## The outbox

Finalize writes the revision **and** a row in `ingestion_jobs` in the same transaction,
then enqueues. This is the outbox pattern, and it removes the failure everyone hits with
queues: a job that exists for a revision that was rolled back, or a revision with no job.

Two guards make delivery safe:

- The BullMQ job id **is** the `ingestion_jobs` row id, so enqueueing twice is a no-op.
- A sweeper re-enqueues rows still `queued` after too long, so a crash between commit and
  enqueue self-heals.

## What the worker does

The worker is a **second entrypoint of the same app**, not a separate service: same
codebase, same modules, no HTTP server. It runs:

1. **Fetch** the object from storage.
2. **Parse** frontmatter out of the body.
3. **Chunk**, heading-aware — a chunk is a section, so a citation points at something a
   reader recognizes.
4. **Embed** each chunk through the configured provider.
5. **Upsert** the graph: document vertex, revision vertex, chunk vertices and their edges.
6. **Mirror** chunks into the BM25 index — non-fatal; a keyword index that is down must
   not fail an indexing run.
7. **Relations**: frontmatter edges are written deterministically; the LLM extractor, if
   configured, adds inferred edges with confidence and evidence. Extraction failures are
   non-fatal — the revision still reaches `indexed`.
8. **Cascade**: queue one level of dependent reindexing for pages that reference the
   entities this page describes.

Then the revision flips to `indexed` and an event goes out on the bus, which is what makes
the page appear in other people's tabs without a refresh.

## Idempotence

Reindexing is safe by construction, not by luck:

- Upserting a revision's chunks **deletes them first**, so a re-run cannot duplicate.
- A job already `completed` is skipped.
- Frontmatter relation edges are deleted and recreated for that revision only.
- Inferred edges are replaced for that revision only, and never over a human's edge.

This is what lets the stale sweeper, the dependent cascade and a manual reindex all point
at the same code without coordinating.

## Watching it

- `GET /v1/ingestion/jobs/:id` — one job's state and attempts.
- `GET /v1/ingestion/stale` — what the sweeper is about to pick up.
- `POST /v1/ingestion/reindex` — force a document or a whole workspace.
- `GET /v1/events` (SSE) and `/v1/events/ws` (WebSocket) — `revision.indexed`,
  `revision.failed`, `revision.dependent-reindex` as they happen.
