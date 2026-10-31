# 68 — Memos: a recording, transcribed, proposed as merge requests

Issue: [#551](https://github.com/hrustalq/knowledge/issues/551). PRs #574 (this record, phase 0), #575 (model and
upload), #578 (transcription), #579 (the secretary and publishing), #580 (web), #581 (MCP, retry, delete,
retention), and this rewrite.

## What

A **memo** is an audio recording a person uploads into a project: meeting minutes, a feature discussion, a
stand-up. The worker transcribes it. The `secretary` agent reads the transcript against the knowledge base,
and every change it proposes (a page to create or a page to update) opens as an ordinary merge request
attributed to the uploader. Nothing is published silently, and a memo that settles nothing ends with zero
proposals and says so.

```
POST /v1/memos (reserve, presigned PUT) → PUT to MinIO → POST :id/finalize
  → memo job (worker): download → ffprobe → ffmpeg 10-min mp3 chunks → STT per chunk → stitch → mask → write
  → secretary run (worker): search as the uploader → summary + proposals → readMemoProposals (code, not prompt)
  → MemoPublishSweeper (API): claim once → re-check editor → one MR per kept proposal → memo.done
```

Status: `pending → uploaded → transcribing → transcribed → analysing → done | failed`. `pending` is the
reserved row before the bucket confirms the bytes. `failed` keeps the `stage` it failed in: `transcribing`
or `analysing`.

## Why

Every intake the platform has starts as text: pages, imports, connectors, chat threads (doc 59), tracker
tickets (doc 32's scribe). What a team decides out loud reached the knowledge base only when somebody wrote
it up afterwards, and mostly nobody did. The one agent called `transcriber` turns scanned images into
markdown for the import OCR parser; there was no speech-to-text anywhere.

## Decisions

### Transcription is env-only, not an `AiPurpose`

An `AiPurpose` route picks a provider *profile*, and every profile is a chat endpoint with a chat model.
Speech needs a different endpoint (`/audio/transcriptions`), model and, self-hosted, usually a different
host. The deployment runs one speech server, so this is one operator setting, the same shape as
`EMBEDDING_*`. `DECISION_PROVIDER` only looks like a precedent: it is a ceiling over a routed purpose, and
here there is nothing to route. If a second tenant needs its own key, a per-workspace route can be added
with this env block as its ceiling.

The URL comes only from env, so it is the operator's, not a user's. `TranscriptionClient` calls it with a
plain `fetch` and a 5-minute timeout per chunk, as the embeddings provider does, not through
`common/safe-url.ts`. That filter stops *user-supplied* URLs from reaching the private network; applied
here it would refuse the LAN server it is meant to reach. Errors reach the uploader as translated text that
names no host.

### One request shape covers every server

`POST {TRANSCRIPTION_BASE_URL}/audio/transcriptions`, multipart: `file`, `model`,
`response_format=verbose_json`, `timestamp_granularities[]=segment`, plus `Authorization: Bearer` when
`TRANSCRIPTION_API_KEY` is set. Hosted Whisper, whisper.cpp's server and speaches all answer with
`{ language, segments: [{ start, end, text }] }`. A server that answers without segments still works: the
chunk becomes one segment spanning it. No `language` is sent, so each chunk is detected on its own and a
recording that switches between ru and en keeps both. Nothing is translated.

### gen-api: text only, so the pieces are short

`TRANSCRIPTION_PROVIDER=gen-api` (#584) calls gen-api's own speech network, `gen-stt` (0.45 ₽ a minute,
billed per second, built for Russian): `POST https://api.gen-api.ru/api/v1/networks/gen-stt`, multipart
`audio_url` (the chunk itself) and `is_sync=true`, answered with `{ request_id, cost, response: [text] }`.
Only `TRANSCRIPTION_API_KEY` is read; the URL is fixed and the model is recorded as `gen-stt`. gen-api's
OpenAI-shaped proxy has no `/audio/transcriptions` route, which is why this is its own branch in
`TranscriptionClient` and not a base URL.

`gen-stt` returns no timestamps: a `timestamps` parameter is accepted and dropped. Each chunk therefore
becomes one segment, so for gen-api the worker cuts pieces of at most `SHORT_CHUNK_SECONDS` (60) instead of
600, each ending at the latest pause in the second half of its minute (`detectPauses` reads ffmpeg's
`silencedetect`, `pauseCuts` picks the points) and cut hard only where a minute has no pause. A proposal
then points at the right minute. A 2-hour memo is about 120 calls of ≈ 6 s each. `language` is not sent; it
defaults to `ru`, a hint gen-api says its main path barely reads, and the memo's language stays empty.

### Audio is normalised, then chunked, in the worker

`MemosProcessor` (in `MemosWorkerModule`, imported only by `worker.module.ts`):

1. Claims the row in one guarded `updateMany` (`uploaded|failed` with no transcript → `transcribing`).
2. Streams the object to a temp dir (`StorageService.downloadToFile`; recordings are too big to hold in
   memory).
3. Runs `ffprobe` to get the length. `MEMO_MAX_MINUTES` is enforced here, on the file. The browser's
   reading at reserve is only an early refusal.
4. Runs `ffmpeg` to write 16 kHz mono mp3 at 32 kbit/s in 600-second segments (≈ 2.4 MB each, under any
   server's cap), or in pieces of at most 60 s cut at pauses for gen-api. Then it transcribes chunk by
   chunk and stitches.
5. Removes the temp dir, whatever the outcome.

`ffmpeg` is in `Dockerfile.api`'s runtime stage; its `-version` calls fail the image build, not the
first memo.

### The transcript is a JSON column, masked before it is written

`memos.transcript` is `jsonb`: `[{ i, start, end, text }]`, seconds. A table would earn its keep only if
segments were queried one by one; nothing does. The list route never selects it (`omit`).

`stitchTranscript` (`memos/transcript.ts`, pure) offsets each chunk's segments, drops silence and runs
every text through **one** `createMasker()` (`chat/harvest-mask.ts`). One masker means a value spoken twice
keeps one placeholder. The unmasked text lives only in the job's memory. Every model prompt and the MCP
output wrap the transcript with `wrapUntrusted(…, 'memo')`. `harvest-mask` reads its credential patterns
from `common/secret-scan.ts`, lifted out of `captures/` because the worker may not reach that folder.

Speech-to-text never writes a credential in its written shape: on prod a spoken password came back as
`Twortistage 2026` and an address as `Дмитрий.rlov sobakexple.com`. So the masker also reads the word in
front of a value — `пароль`, `ключ`, `токен`, `password`, `api key`, `телефон` — and masks spoken addresses
and bare `+` numbers (doc 59, *Masking*). A credential said with no such word, and with no digit or Latin
letter in it, still reaches the transcript.

### A memo is a row, private to its uploader

`memos`: workspace, project, `created_by`, title, filename, content type, size, `audio_key`,
`audio_purged_at`, duration, language, status, stage, error, transcript, summary, dropped, `agent_run_id`,
`published_at`, locale. There is no FK on `workspace_id` / `created_by`. Audio lives at
`workspaces/{ws}/memos/{id}/source.<ext>`, under the workspace prefix teardown purges, and `Memo` is filed
in `workspace-teardown.inventory.ts`.

- **Never a document.** It is not indexed, searchable or cited by the assistant. Only the memo page, its
  own analysis run and its uploader's MCP tools read it.
- **Uploader only.** `MemosService.require` matches `created_by` unless the caller is a platform admin.
  Anyone else gets a bare **404** (`Memo not found`, no id, no title), over REST and MCP alike. The ACL
  source `memo` resolves the workspace in PG first, so another tenant's id is a 403.
- **Uploading takes `editor`**, and a project the caller can see. A viewer's memo could open no merge
  request. Reads take `viewer`, so a person demoted after uploading still reads their own memos.
- **The stored content type is the format's own** (`MEMO_FORMATS`), never the client's claim: the audio
  route serves it inline, and a claimed `text/html` must not render.

### The analysis is an agent run: `secretary`

The built-in agent is `secretary` (en «Secretary», ru «Секретарь»): purpose `review`, surface
`background`, read tools only. It is not in `RUNNABLE_AGENTS`, so it has no Run button, no schedule and
no trigger. Once the transcript is written, `MemosProcessor.analyse` creates the `agent_runs` row in the
uploader's name (`trigger: 'manual'`, `subjectKey: memo:<id>`, `input.memo = { memoId }`), sets the memo
to `analysing` and enqueues the run. The worker already creates runs (the schedule sweeper), and a run
brings retries, budget and attribution.

`AgentExecutor.minute` shows the masked transcript as `[n] m:ss–m:ss text` lines. It runs the read tools
as the uploader and collects every page id a tool result carried. Its model calls bill as `memo`. It writes
the summary and the dropped list onto the memo.

`readMemoProposals` (`agents/memo.ts`, pure, pinned by `test/memo-secretary.spec.ts`) enforces the rules
in code. A proposal is **dropped, with a reason the memo page shows**, when it:

- cites a segment the transcript does not have, or cites none (`unknown-segment`);
- updates a page that is not both **retrieved by this run's tools** and **readable by the uploader**
  (`visibilityWhere(scope)`) (`unknown-page`). A page the uploader can read but the run never opened is a
  guess, and a restricted page can never be read or rewritten through a memo. This is stricter than the
  scribe;
- is shorter than a page (`too-short`), repeats an update of one page (`duplicate`), or falls past
  `MEMO_MAX_PROPOSALS` (`over-limit`).

Each kept proposal is a finding in the scribe's shape plus `memo: { action, segments }`. The action is
stored because publishing a create writes the new page into `documentIds`. Its sources are
`{WEB_BASE_URL}/memos/<id>?t=<seconds>` links labelled by time only (`Memo · 1:02`, via `memoClock` in
contracts). They never carry the memo's title or words, so a reviewer who cannot open the memo learns
nothing from the merge request.

### Publishing: `MemoPublishSweeper`, API-only

The worker generates and the API publishes. `MemoPublishSweeper` (in `MemosModule`, 15 s tick,
back-pressure; `ScribePublishSweeper`'s shape) finds memos in `analysing` whose run has finished:

- It **claims once** by guarding on `published_at IS NULL`.
- It rebuilds the uploader's principal and checks `editor` **now**.
- An update opens through `AgentFindingsService.propose`, which uses the draft with no model call. A create
  opens through `proposePage` into the memo's project: head-less behind `pending_merge_request_id`, so it
  is absent from the tree and search until it merges.
- The memo moves to `done`, and the uploader alone gets `memo.done` with counts only (`job` category; the
  inbox links to `/memos/:id`).
- A failed or cancelled run, or a refused role, leaves the memo `failed` at `analysing`, sends
  `memo.failed`, and releases the claim so Retry can publish again.
- A proposal that fails to open stays on the run, where its owner can propose it by hand.

### Spend

`transcription` gives one `ai_usage` row per attempt that reached ffprobe, billed to the uploader, with
the length in the new nullable `ai_usage.audio_seconds` (tokens zero, and `audioSeconds` on the usage log
entries). It is written by `AiUsageService.recordTranscription`, because env-configured speech has no
resolved config: the row's provider is `TRANSCRIPTION_PROVIDER`, and its cost is the sum of the `cost`
gen-stt reports per chunk (null when any chunk reports none, which an OpenAI-compatible server never
does). `memo` covers the secretary's model calls. Reserve calls `assertWithinBudget` before handing out a URL.

### Lifecycle

- **Retry** (`POST :id/retry`, guarded on `failed`): a memo with a transcript is re-read by a new run; one
  without is transcribed again. The second path is refused while transcription is off.
- **Delete** (`DELETE :id`): the row (transcript included), then every version of the audio
  (`purgeObjectVersions`). Merge requests it opened stay; their links then 404 like any other.
- **Retention**: `MemoRetentionSweeper` (worker, 10-minute tick, back-pressure) purges every version of
  settled (`done`/`failed`) audio older than `MEMO_AUDIO_RETENTION_DAYS` and stamps `audio_purged_at`. The
  transcript and proposals stay. `0` keeps audio. Reservations never finalized are dropped after a day.

## Surface

REST, each route `@Access` + `@Returns`:

| route                                 | role   | what                                                                    |
| ------------------------------------- | ------ | ----------------------------------------------------------------------- |
| `GET /v1/memos?workspaceId&projectId` | viewer | my memos, no transcript; `transcription: { enabled, missing }`, `limits` |
| `POST /v1/memos`                      | editor | reserve: row + presigned PUT; 503 `transcription-disabled` when off       |
| `POST /v1/memos/:id/finalize`         | editor | size re-read from the bucket, transcription queued                       |
| `GET /v1/memos/:id`                   | viewer | memo, transcript, summary, proposals with merge requests, dropped        |
| `GET /v1/memos/:id/audio`             | viewer | 302 to a presigned GET (session cookie, `<audio>` sends no header)        |
| `POST /v1/memos/:id/retry`            | editor | resume a failed memo                                                     |
| `DELETE /v1/memos/:id`                | editor | purge audio + row                                                        |

MCP: `knowledge_list_memos` (`guard.ws`, viewer) and `knowledge_get_memo` (`guard.memo`, viewer; the memo
wrapped untrusted). They are read-only, served by the same `MemosService`, and return the same 404.

Web (`/memos` after Captures in the sidebar; design brief on #551):

- **Upload.** One act: pick or drop. Format, size and the length the browser reads are refused before
  upload. Real progress comes from `presignedPut`.
- **List.** Rows show icon + hue status and poll while anything moves. With transcription off, a warning
  callout names the variable to set and there is no upload control.
- **`/memos/:id`.** The transcript is on the left, and each line plays from it. A sticky, self-scrolling
  rail holds the player, summary, proposals and the dropped list. A proposal's timestamp chips seek the
  player and mark the cited lines. The rail comes first below `lg`. `?t=` from a merge request seeks once.
  Retry (failed only) and Delete (confirmed) sit in the header.

## Operations

- Migration `20261219100000_memos`: the `memos` table and nullable `ai_usage.audio_seconds`. Both survive
  a rollback.
- Env, all defaulted and off: `TRANSCRIPTION_PROVIDER` (`none` | `openai-compatible` | `gen-api`),
  `TRANSCRIPTION_BASE_URL`, `TRANSCRIPTION_MODEL` (`whisper-1`), `TRANSCRIPTION_API_KEY`, `MEMO_MAX_BYTES`
  (200 MB), `MEMO_MAX_MINUTES` (120), `MEMO_MAX_PROPOSALS` (3), `MEMO_AUDIO_RETENTION_DAYS` (30). To turn
  memos on, set the first two in the GitHub `production` environment (and the key for a hosted server), or
  `TRANSCRIPTION_PROVIDER=gen-api` with `TRANSCRIPTION_API_KEY` alone.
  deploy.yml refuses variables missing from that environment.
- The `api` image carries `ffmpeg` / `ffprobe`; the build checks them.

## Deliberate deferrals

- Recording in the browser, meeting bots, Telegram voice notes: upload only.
- Speaker diarization: segments carry time, not speakers.
- Searchable or citable transcripts; shared or project-visible memos.
- Video files; captures other than pages (glossary terms, relations).
- A per-workspace transcription route, and a configured per-minute price (only a cost the speech server
  reports is recorded).
- One prompt window per memo: past ~150k characters of transcript (beyond the 120-minute default) the tail
  is not shown to the secretary (`// ponytail:` in `agents/memo.ts`).

## Verification

- Specs:
  - `test/memos.spec.ts`: formats, the disabled state, the uploader-only `where`, stitching and masking,
    retention, retry.
  - `test/memo-secretary.spec.ts`: every drop rule, time-only links, small talk ending in zero proposals.
  - `apps/web/.../memo-ui.spec.ts`.
- `docker build -f Dockerfile.api` locally: green, with ffmpeg 5.1.9.
- End to end against local infra with a **fake** speech server, with `ffmpeg` running inside the built
  image:
  - A Russian recording reached `transcribed`, its spoken token and email stored as `[SECRET_1]` /
    `[EMAIL_1]`, with one `transcription` row of 4 s.
  - With the speech server down, the memo was `failed` at `transcribing`.
- The publish path, from a seeded finished `secretary` run:
  - It opened an update MR and a head-less create MR whose descriptions link `…/memos/<id>?t=62`.
  - The memo reached `done`, and one `memo.done` notification went to the uploader.
- The web pages in Chrome at 1440 / 1280 / 390 px in Russian. MCP tools, retry and delete were exercised
  over HTTP.
- **Not yet verified** (dogfood at release):
  - real Whisper (or speaches) output on a 30-minute Russian recording;
  - a real model running the secretary (only the paid gen-api was configured locally);
  - the >10-minute multi-chunk path end to end;
  - a second, non-admin member getting 404s (dev mode is a platform admin).
