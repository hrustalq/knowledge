# 68 — Memos: a recording, transcribed, proposed as merge requests

Issue: [#551](https://github.com/hrustalq/knowledge/issues/551). This document is the phase 0 decision record;
phase 6 rewrites it to match what shipped.

## What

A **memo** is an audio recording a person uploads into a project: meeting minutes, a feature discussion, a
stand-up. The worker transcribes it, the `secretary` agent reads the transcript against the knowledge base,
and every change it proposes — a page to create or a page to update — opens as an ordinary merge request
attributed to the uploader. Nothing is published silently, and a memo that settles nothing ends with zero
proposals and says so.

```
reserve (presigned PUT) → finalize → transcribe (worker: ffmpeg → chunks → STT → stitch → mask)
  → secretary run (worker: search as the uploader → summary + proposals, validated in code)
  → MemoPublishSweeper (API: one merge request per kept proposal, notification) → done
```

## Why

Every intake the platform has starts as text: pages, imports, connectors, chat threads (doc 59), tracker
tickets (doc 32's scribe). What a team decides out loud reaches the knowledge base only when somebody writes
it up afterwards, and mostly nobody does. There is no speech-to-text anywhere in the repo; the one agent
called `transcriber` turns scanned images into markdown for the import OCR parser.

## Decisions

### Transcription is env-only, not an `AiPurpose`

Asked on #551: route it through `resolveFor` like `decision`, or configure it in env? **Env only.**

- An `AiPurpose` route picks a provider *profile*, and every profile today is a chat endpoint with a chat
  model. Transcription needs a different endpoint (`/audio/transcriptions`), a different model and, for a
  self-hosted server, usually a different host. A route would mean profiles that are half chat, half
  speech, and a settings UI to say which half applies.
- The deployment this is for runs one speech server (hosted Whisper, or whisper.cpp / speaches on the
  mini). That is one operator setting, the same shape as `EMBEDDING_*`.
- `DECISION_PROVIDER` is not the precedent it looks like: it is a ceiling over a routed purpose. Here
  there is nothing to route.

A per-workspace route is a follow-up if a second tenant needs its own key; the env block then becomes its
ceiling, as `DECISION_PROVIDER` is for `decision`.

### Env

Every value has a default, because `generate-openapi.main.ts` validates env with no infrastructure.

| var                         | default    | meaning                                                                   |
| --------------------------- | ---------- | ------------------------------------------------------------------------- |
| `TRANSCRIPTION_PROVIDER`    | `none`     | `none` \| `openai-compatible`. `none` turns memos off: the page explains, reserve refuses |
| `TRANSCRIPTION_BASE_URL`    | `''`       | e.g. `https://api.openai.com/v1`, `http://192.168.20.10:8000/v1`          |
| `TRANSCRIPTION_MODEL`       | `whisper-1`| sent as `model`                                                           |
| `TRANSCRIPTION_API_KEY`     | `''`       | sent as `Authorization: Bearer …` when set                                 |
| `MEMO_MAX_BYTES`            | 200 MB     | refused at reserve (claimed size) and at finalize (size read from the bucket) |
| `MEMO_MAX_MINUTES`          | `120`      | refused at reserve when the browser read a longer duration; enforced by ffprobe in the worker |
| `MEMO_AUDIO_RETENTION_DAYS` | `30`       | audio older than this is purged, the transcript kept; `0` keeps audio forever |
| `MEMO_MAX_PROPOSALS`        | `3`        | proposals kept from one memo — each is a merge request somebody reviews    |

`openai-compatible` with an empty base URL is the same as `none`, and the disabled state names the missing
variable. The base URL comes only from env, so it is the operator's URL, not a user's: it is called with a
plain `fetch` and a timeout, as `EMBEDDING_*` and `ASSISTANT_BASE_URL` are, not through `common/safe-url.ts`.
That filter exists to stop a *user-supplied* URL reaching the private network; applied here it would refuse
the self-hosted server on the LAN it is meant to reach.

### One request shape covers every server

`POST {base}/audio/transcriptions`, multipart: `file`, `model`, `response_format=verbose_json`,
`timestamp_granularities[]=segment`. Hosted Whisper, whisper.cpp's server and speaches all answer it with
`{ language, duration, segments: [{ start, end, text }] }`. A server that answers without `segments`
(`gpt-4o-transcribe` returns text only) still works: the chunk becomes one segment spanning the chunk.
No `language` is sent, so each chunk is detected on its own and a recording that switches between ru and
en keeps both. Nothing is ever translated.

### Audio is normalised, then chunked

The worker downloads the object to a temp dir, `ffprobe`s the duration (refusing past `MEMO_MAX_MINUTES`),
and has `ffmpeg` write **16 kHz mono mp3 at 32 kbit/s in 10-minute segments** (`-f segment -segment_time
600`). That is ≈ 2.4 MB per chunk, well under the 25 MB hosted Whisper accepts, and every server reads mp3.
Chunks are transcribed in order; each segment's times are offset by its chunk's start, and the stitched
transcript is one list. `ffmpeg` goes into `Dockerfile.api`, so the worker image carries it; the build
ends with `ffmpeg -version` so a missing binary fails the image, not the first memo.

### The transcript is a JSON column, masked before it is written

`memos.transcript` is `jsonb`: `[{ i, start, end, text }]`, seconds as numbers. A table would earn its keep
only if segments were queried one by one, and nothing does — the memo page and the analysis run both read
the whole list. A two-hour recording is a few hundred segments, a few hundred KB at worst. The list route
never selects the column.

Every segment goes through one `createMasker()` (`chat/harvest-mask.ts`, doc 59) **before** the row is
written, so the same spoken value keeps the same placeholder across segments. The unmasked text exists only
in the job's memory. Every prompt that carries the transcript wraps it with `wrapUntrusted(…, 'memo')`, a
new origin: a recording is what people in a room said, not instructions.

### A memo is a row, private to its uploader

`memos`: `workspace_id`, `project_id`, `created_by`, `title`, `filename`, `content_type`, `size_bytes`,
`audio_key`, `audio_purged_at`, `duration_seconds`, `language`, `status`, `stage`, `error`, `transcript`,
`summary`, `dropped`, `agent_run_id`, `published_at`, `locale`, timestamps. No FK on `workspace_id` or
`created_by` (house policy). Audio lives at `workspaces/{ws}/memos/{memoId}/source.<ext>`, so workspace
teardown's `purgePrefix` covers it, and the model is filed in `workspace-teardown.inventory.ts`.

- **Never a document**: not indexed, not searchable, not cited by the assistant — read on the memo page and
  by its own analysis run only, as the harvest buffer is (doc 59).
- **Visible to its uploader only.** Every read is `WHERE created_by = me`, and a memo that is not yours is
  a **404** — never a 403, which would confirm it exists — with no title in the body. Platform admins
  bypass this as they bypass every page restriction. The routes still carry `@Access` (the workspace is
  resolved from the memo in PG first, so a cross-tenant id 403s before ownership is looked at).
- **Uploading takes `editor`** in the workspace, and the project must be one the caller can see. A viewer's
  memo could open no merge request, so it is refused at the door instead of failing at the end.
- Reads take `viewer`: a person demoted after uploading still reads their own memos.

### Status

`pending → uploaded → transcribing → transcribed → analysing → done | failed`.

`pending` is the one state #551 did not name: the row reserve creates before the bytes are confirmed
(import's `pending`). A `pending` row older than a day is deleted by the retention sweeper. `failed` keeps
the `stage` it failed in, and **Retry** resumes from it: a memo with a transcript re-runs the analysis
only; one without re-transcribes. `done` with zero proposals is a normal outcome, shown as one.

### The analysis is an agent run: `secretary`

A built-in agent `secretary` (ru «Секретарь»; `transcriber` is taken). Purpose `review`, surface
`background`, `requires: ['json', 'tools']`, read tools only. The transcription job, once it writes the
transcript, creates the `agent_runs` row itself (`trigger: 'manual'`, `subjectKey: memo:<id>`,
`createdBy` = the uploader, `input.memo = { memoId }`) and enqueues it — the worker already creates runs
(`AgentScheduleSweeper`), and the run gets retries, budget, usage attribution and the runs list for free.

`agents/memo.ts`, pure and beside `scribe.ts`, holds the prompt, the output contract and the validation:

```json
{ "summary": "…", "proposals": [{ "action": "create|update", "documentId": "…", "title": "…",
  "detail": "…", "markdown": "…", "segments": [3, 7] }] }
```

Validation is code, not prompt. A proposal is **dropped, with a reason the memo page shows**, when it:

- cites a segment index the transcript does not have, or cites none (`unknown-segment`);
- updates a `documentId` **the run's own tool calls never returned** (`unknown-page`). This is stricter
  than the scribe, which accepts any page the scope can read: the executor wraps the read-tool loop and
  collects every document id a tool result carried, and only those are updatable. The ids are then
  re-checked against `visibilityWhere(scope)`, so a page restricted from the uploader can never be read or
  rewritten through their memo;
- is shorter than a page (`MIN_DRAFT_CHARS`), duplicates an update to the same page, or falls past
  `MEMO_MAX_PROPOSALS` (`too-short`, `duplicate`, `over-limit`).

Kept proposals are the run's findings in the scribe's shape. Dropped ones, with title and reason, go to
`memos.dropped`. The worker writes the summary and `dropped` onto the memo when the run ends.

### Publishing: `MemoPublishSweeper`, API-only

The worker generates, the API publishes. `MemoPublishSweeper` (a `setInterval` tick with back-pressure,
`ScribePublishSweeper`'s shape) finds memos in `analysing` whose run has finished:

- **claimed once** by a guarded `UPDATE memos SET published_at = now() WHERE id = … AND published_at IS
  NULL`, so two sweeps never both publish;
- the uploader's principal is rebuilt and `requireRole(…, 'editor')` checked **now**, not at upload;
- an update opens through `AgentFindingsService.propose`, a create through `proposePage` into the memo's
  project — a head-less page behind `pending_merge_request_id`, absent from the tree and search until it
  merges (docs 50, 66);
- each merge request's description links the memo and the cited timestamps
  (`/memos/<id>?t=<seconds>`), labelled by time only — **never the memo's title or transcript text**, so a
  reviewer who cannot open the memo learns nothing from the link;
- then the memo moves to `done` and the uploader gets one notification (`memo.done`, counts only). A failed
  run moves it to `failed` at stage `analysing`. A run that finished while the API was down is picked up
  on the next tick — the sweeper is the recovery path too.

A proposal that fails to open stays on the run, where its owner can still propose it by hand.

### Spend

Two `AiUsageOperation` values: `transcription` — one row per memo, billed to the uploader, with the
recording's length in a new nullable `ai_usage.audio_seconds` column (tokens zero, `estimated: false`) —
and `memo`, the `secretary` run's model calls. Reserve calls `assertWithinBudget` before handing out a URL.

### Lifecycle

- **Delete** (`DELETE /v1/memos/:id`, uploader only) removes the audio objects and the row, transcript
  included. Merge requests it opened are ordinary merge requests and stay.
- **Retention**: `MemoRetentionSweeper` (worker, fixed tick) purges audio older than
  `MEMO_AUDIO_RETENTION_DAYS` and stamps `audio_purged_at`; the transcript and proposals stay, and the
  player says the recording was removed. It also drops stale `pending` rows.

## Surface (planned)

REST, every route `@Access` + `@Returns`:

| route                              | role   | what                                                     |
| ---------------------------------- | ------ | -------------------------------------------------------- |
| `GET /v1/memos?workspaceId&projectId` | viewer | my memos, newest first, no transcript; `transcription: { enabled, missing }` |
| `POST /v1/memos`                   | editor | reserve: row + presigned PUT                             |
| `POST /v1/memos/:id/finalize`      | editor | size re-read from the bucket, transcription queued       |
| `GET /v1/memos/:id`                | viewer | the memo, transcript, summary, proposals with their MRs, dropped |
| `GET /v1/memos/:id/audio`          | viewer | 302 to a presigned GET (an `<audio>` cannot send a header) |
| `POST /v1/memos/:id/retry`         | editor | resume a failed memo                                     |
| `DELETE /v1/memos/:id`             | editor | purge audio + row                                        |

MCP: `knowledge_list_memos`, `knowledge_get_memo` — read tools, guarded at the same role as their REST
twins, same ownership rule, same 404.

Web: `/memos` (list, upload, the disabled state naming the missing variable) and `/memos/:id` (player,
transcript whose segments seek the player, summary, proposals with their merge requests or the reason
each was dropped). en + ru.

## Phases

One PR into `dev` per phase; each leaves the app working.

1. Model and upload — migration (`memos`, `ai_usage.audio_seconds`), reserve/finalize/get/list, teardown
   inventory.
2. Transcription — ffmpeg in `Dockerfile.api`, env block, the STT client, `MemosWorkerModule` (worker
   only), masking, the `transcription` usage row.
3. Analysis and proposals — `secretary`, `agents/memo.ts` + spec, `MemoPublishSweeper`, notification.
4. Web — `/memos`, the memo page, the disabled state.
5. MCP and lifecycle — the two read tools, delete, retry, `MemoRetentionSweeper`.
6. Docs — this document rewritten to what shipped, `docs/architecture/03-ingestion.md`, CHANGELOG.

## Deliberate deferrals

- Recording in the browser, meeting bots, Telegram voice notes — upload only.
- Speaker diarization: segments carry time, not speakers.
- Searchable or citable transcripts; shared or project-visible memos.
- Video files; captures other than pages (glossary terms, relations).
- A per-workspace transcription route (see above) and a per-minute cost column.
