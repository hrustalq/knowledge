# 74 — Plaud import: a linked account's recordings become memos

Issue: [#864](https://github.com/hrustalq/knowledge/issues/864). PRs #865 (link an account), #866 (import one
recording), #867 (pick rules, the queue, the sweeper), #868 ("Transcribe here"), #869 (web), and this record.

## What

A person links their **Plaud** account once. Recordings that match their pick rules, and that Plaud has
already transcribed, show up for a yes or no and become ordinary memos (doc 68) built from **Plaud's
transcript**, speaker names included. Everything after the transcript is doc 68 unchanged: the `secretary`
run, `readMemoProposals`, `MemoPublishSweeper`, merge requests in the person's name.

```
GET /v1/plaud/authorize → Plaud sign-in (PKCE) → GET /v1/plaud/callback → credentials row (provider 'plaud')
PUT /v1/plaud/settings { projectId, rules }                       → plaud_links
PlaudImportSweeper (API, each link every 10 min, as that person)  → list_files → picks() → plaud_imports
  waiting (no Plaud transcript yet) → pending (ask) → confirm → MemosService.importPlaud
  → get_transcript, every page → stitchTranscript (one masker) → memo inserted `transcribed` → analyse (doc 68)
```

Our own speech-to-text runs for a Plaud recording only when its owner presses **Transcribe here** on one
waiting row.

## Why

A memo started from an audio file uploaded by hand. People who record meetings on a Plaud device already
have the recording and a transcript with named speakers and timestamps in their Plaud account. The only way
in was to export a file and upload it, after which we paid to transcribe it a second time and lost the
speakers.

## Decisions

### The link is a person's own sign-in against Plaud's MCP server

Plaud's hosted MCP server (`https://mcp.plaud.ai`) is the one API open to a client Plaud did not issue:
`POST /register` hands out a **public** client (no secret, no approval step). The operator registers one
once and sets `PLAUD_OAUTH_CLIENT_ID`; empty is the off switch, and then `GET /v1/plaud/link` answers "not
set up", the sweeper never starts and the web panel draws nothing.

`PlaudOauthService` runs the authorization code flow with PKCE `S256`, shaped like `FigmaOauthService`:
signed state carrying a sealed verifier, a `@Public()` callback gated by that state, landing on
`/oauth/plaud` (`oauthLandingPath`). The sign-in is stored as the caller's own `credentials` row
(`provider: 'plaud'`, `method: 'oauth'`, #857), sealed by `ai/secret-box.ts`. `plaud` is in
`CONNECTION_PROVIDERS` with no connector kind, and `GET /v1/me/credentials` lists only connector providers,
so it is never drawn as a connector account.

It is **never a workspace connection**: a memo is private to its uploader, and every Plaud call is made as
the person whose recordings they are.

### Refresh is single-flight, because Plaud rotates the refresh token

Access tokens last 24 hours, refresh tokens 7 days, and **every refresh issues a new refresh token**. A
second concurrent refresh would present a spent token, be refused, and read as a lapsed sign-in. So
`tokenFor(userId)` refreshes under the lease on `credentials.refreshing_until`, and writes both tokens and
both expiries together.

Seven days without a refresh loses the sign-in, so the sweeper asks for the token on every pass over every
link, including a link with auto-import switched off. That is the keep-alive.

**Unlink cannot revoke at Plaud**: the HTTP server has no revoke endpoint. Unlinking deletes our copy of
both tokens, the settings and the queue; the grant expires at Plaud within 7 days. Link and unlink write no
audit action, as for GitHub and Figma sign-ins.

### One client, one parser

`plaud.client.ts` posts JSON-RPC to the fixed MCP URL. The endpoint is stateless (no `initialize`), needs
`Accept: application/json, text/event-stream` (406 otherwise) and answers as one server-sent `data:` line.
Only Plaud's read tools are called: `list_files`, `get_file`, `get_transcript`, `get_current_user`.

Recording answers are JSON inside an `<untrusted-user-data-<random>>` envelope whose tag is random per call.
The sentence in front of it names the tag too, so `parsePlaudAnswer` takes the tag that **opens a line**.
`get_current_user` answers bare JSON. Anything that matches neither shape throws and fails the import; no
answer is ever interpreted loosely.

`PlaudService` (in the controller-free `PlaudCoreModule`, so the worker can reach it) reads a recording, its
transcript (every page, 500 utterances an answer, milliseconds to seconds), the listing and the audio link,
and refreshes once when Plaud refuses the token. An untranscribed recording answers `get_transcript` with a
bare `[]`.

Plaud's own error text is never passed on to a person or a log line a person reads: it may quote a
recording. Refusals are our translated codes: 409 `plaud-not-linked`, 409 `plaud-not-transcribed`, 413 over
`MEMO_MAX_MINUTES`, 502 `plaud-failed`.

### A Plaud memo is an ordinary memo that starts at `transcribed`

`MemosService.importPlaud` checks what an upload checks (`editor`, the project and its visibility,
`assertWithinBudget`, `MEMO_MAX_MINUTES`), reads the transcript as the caller, and runs the utterances
through `stitchTranscript`, so **one `createMasker()`** covers the memo before the single write. The
unmasked text is never stored. `MemosProcessor` sends a memo that already has a transcript straight to
`analyse`.

- **No speech-to-text.** Import works with `TRANSCRIPTION_PROVIDER=none` and writes no `transcription`
  usage row.
- **Speakers.** `MemoSegment` has an optional `speaker` (masked like the text). `memoPrompt` shows the
  secretary `[n] m:ss–m:ss Name: text`, and the memo page puts the name in front of each line.
- **Source.** `memos.source` is `upload` or `plaud`; `memos.external_id` is Plaud's recording id. A unique
  index over `(workspace_id, created_by, source, external_id)` makes a second import return the first memo;
  a race loses on the index and returns the winner's.
- **No audio, and no schema change for it.** `audio_key` is `''` and `audio_purged_at` is set: the state
  retention already leaves a memo in. `audioAvailable`, the audio route, delete and the retention sweeper
  behave with no new branch. The memo page says the audio stays in Plaud.
- **The title is ours.** `memoPrompt` puts a memo's title outside the untrusted wrapper, and a Plaud name
  can be text Plaud's model wrote from the recording. The memo is titled `Plaud · <start time>`; Plaud's
  name is kept as `filename`, which is only displayed.

Uploader-only access is doc 68's, untouched: anyone else gets a bare 404.

### Pick rules are read by one pure function

`plaud_links` holds one row per person per workspace: the destination project (null = auto-import off, the
rules are kept) and `rules`, a sparse override of `PLAUD_RULE_DEFAULTS` (contracts). `plaud-rules.ts` is the
only reader:

| rule                            | default                               |
| ------------------------------- | ------------------------------------- |
| `since`                         | the day the settings were first saved |
| `minSeconds`                    | 120                                   |
| `nameIncludes` / `nameExcludes` | none                                  |
| `serial` (device)               | any                                   |
| `confirm`                       | `ask` (or `auto`)                     |

The `since` default means linking imports **no backlog**. `GET /v1/plaud/settings` returns both what was
saved and what applies once the defaults are filled in.

A sweep lists from `since` but never further back than `LOOKBACK_DAYS` (14). There is no cursor column: a
recording that reaches Plaud later than that is not picked up until `since` is moved back.

### The queue holds a listing, never speech

`plaud_imports` is one row per picked recording: Plaud's id, name, start, length, status. **No transcript.**
Nothing of a recording's speech is read or stored before it becomes a memo. The name is shown to its owner
and never sent to a model.

| status      | meaning                                                                      |
| ----------- | ---------------------------------------------------------------------------- |
| `waiting`   | Plaud has no transcript yet. The person starts one in the Plaud app.         |
| `pending`   | transcribed, waiting for a yes (`ask` mode)                                  |
| `confirmed` | a yes given ahead of the transcript: imported as soon as Plaud has one       |
| `imported`  | a memo exists (`memo_id`)                                                    |
| `skipped`   | final. `createMany … skipDuplicates` on `(link_id, external_id)` never re-adds it |
| `failed`    | a translated reason; can be confirmed again                                  |

A recording Plaud has not transcribed is never imported on its own. On a real account most recordings are
in that state, because Plaud transcribes only when asked to in its app.

### The sweeper is API-only and acts as the person

`PlaudImportSweeper` (in `PlaudModule`, `Ticker` + `exclusive`, 60 s tick) takes up to five due links a
tick. A link is due every ten minutes and is claimed by moving `checked_at` in one guarded statement, so two
API processes never sweep one account at once. On every pass it:

- skips a workspace being deleted;
- asks for the token (the keep-alive);
- rebuilds the person's principal and checks `editor` **now**, not when the settings were saved;
- calls `PlaudImportsService.sweepLink`: list, `picks`, insert new rows, probe waiting rows for a
  transcript, import `confirmed` rows and, under `auto`, the newly transcribed ones.

It lives API-side for the house reason: an import opens a memo in a person's name.

`PLAUD_AUTO_IMPORT_MAX_PER_DAY` (default 10) stops `auto` for a person once that many of their recordings
were imported in a day. It is counted from the rows, not a stored counter, and a recording the person
confirms still goes through.

Notifications go to the account's owner alone, category `job`, with the title `Plaud` and never a recording
name: `plaud.pending` once per pass that newly moved recordings to `pending`, carrying a count;
`plaud.reconnect` once per lapse. **Reconnect is derived** from the credential; the link stores only
`reconnect_notified_at`, cleared when the sign-in works again. Both link to `/memos`.

### "Transcribe here" is the only path to our speech-to-text

`POST /v1/plaud/imports/transcribe` takes one of the caller's own rows in `waiting`, `confirmed` or
`failed`; anything else is a 404. Neither `sweepLink` nor the sweeper has a path to it, and `auto` mode
never spends on it. Checked when it runs, in this order:

1. transcription is on (503 `transcription-disabled`, before Plaud is asked anything);
2. the project and its visibility;
3. `assertWithinBudget`;
4. `MEMO_MAX_MINUTES` (413);
5. the allowance (409 `plaud-transcribe-allowance` with `remainingSeconds`).

A refusal leaves the queue row as it was, so the recording still imports the normal way once Plaud
transcribes it.

The **allowance** is `PLAUD_TRANSCRIBE_MINUTES_PER_MONTH` (default 120, 0 = off) less the person's
`ai_usage.audio_seconds` for `transcription` in the workspace over the last 30 days. There is no stored
counter. Uploaded memos count toward it; it never refuses an upload.

The memo is inserted `uploaded` with `source: 'plaud'` under the same unique index, so a second press is the
same memo. **No copy of the audio is kept**: `MemosProcessor` asks `PlaudService.audioUrl` for Plaud's
24-hour link at that moment (never stored), streams it to the temp file through `safeFetch`, and fails the
stream past `MEMO_MAX_BYTES`. From there the pipeline is doc 68's: ffprobe enforces the length on the file
and the usage row is written as for any memo. Retry reads the audio from Plaud again. Such a memo has no
speaker names; our speech-to-text does not diarize.

## Surface

REST, all `@Feature('memos')`, each `@Access` + `@Returns` except the callback:

| route                                  | role   | what                                                                   |
| -------------------------------------- | ------ | ---------------------------------------------------------------------- |
| `GET /v1/plaud/authorize?workspaceId`  | editor | the Plaud sign-in URL                                                  |
| `GET /v1/plaud/callback`               | public | gated by the signed state; stores the credential, lands on `/oauth/plaud` |
| `GET /v1/plaud/link?workspaceId`       | viewer | configured, linked, account label, lapsed                              |
| `DELETE /v1/plaud/link?workspaceId`    | viewer | forget the sign-in, the settings and the queue                         |
| `GET /v1/plaud/settings`               | viewer | project, rules saved and applied, `transcribe: { enabled, limitSeconds, remainingSeconds }` |
| `PUT /v1/plaud/settings`               | editor | `{ workspaceId, projectId, rules }`                                    |
| `GET /v1/plaud/imports`                | viewer | my queue                                                               |
| `POST /v1/plaud/imports/refresh`       | editor | `{ workspaceId }`: my own pass now, at most once in 30 s (#873)        |
| `POST /v1/plaud/imports/confirm`       | editor | `{ workspaceId, ids, projectId? }`: import now, or when Plaud has one   |
| `POST /v1/plaud/imports/skip`          | editor | `{ workspaceId, ids }`: final                                          |
| `POST /v1/plaud/imports/transcribe`    | editor | `{ workspaceId, id }`: "Transcribe here"                               |
| `POST /v1/memos/plaud`                 | editor | `{ workspaceId, projectId, fileId }`: import one recording directly    |

Confirm and skip take a list, so one shape serves a single row and a bulk action. Ids that are not the
caller's open rows in that workspace are ignored.

MCP: nothing new. An imported memo is read through doc 68's `knowledge_list_memos` / `knowledge_get_memo`.

Web (`/memos`, design brief on #864):

- **`PlaudPanel`** sits between Upload and the list and draws nothing when Plaud is not set up. Its header
  shows the link state and one action: Link (in a new tab), Link again (lapsed), Set up import (no project
  yet) or Rules.
- **The queue**, in three groups: waiting for a yes (Import / Skip for one row, the ticked rows, or all);
  refused imports with the server's reason, Try again and Skip; and, folded by default, recordings waiting
  for Plaud's transcript, with "Import when ready" and "Transcribe here".
- **`PlaudRulesDialog`**: destination project or off, the rules with defaults shown as values, ask | auto
  with the daily cap spelled out. Unlink is here, behind a confirmation.
- **"Transcribe here"** opens a dialog stating the recording's length, the minutes left in the allowance and
  that speaker names will be missing. Past the allowance the action is disabled; with transcription off the
  button is absent.

## Operations

- `PLAUD_OAUTH_CLIENT_ID`, empty by default = off. To turn linking on, register a public client once (the
  `curl` is in `.env.example`; redirect URI `$API_PUBLIC_URL/v1/plaud/callback`,
  `token_endpoint_auth_method` `none`) and set the returned `client_id` as a GitHub `production` variable.
  There is no secret. `SETTINGS_ENCRYPTION_KEY` must be set.
- `PLAUD_AUTO_IMPORT_MAX_PER_DAY` (10) and `PLAUD_TRANSCRIBE_MINUTES_PER_MONTH` (120, 0 = off), both
  optional.
- Migrations `20270105100000_memo_source` (`memos.source`, `memos.external_id`, the unique index) and
  `20270106100000_plaud_queue` (`plaud_links`, `plaud_imports`) are additive and survive a rollback.
- Both tables are filed in `workspace-teardown.inventory.ts`; deleting a workspace removes their rows. The
  person's `credentials` row is theirs, not the workspace's.
- "Transcribe here" needs the worker to reach Plaud's audio host over the internet.

## Deliberate deferrals

- Plaud's own AI notes, outline and polished transcript.
- Keeping audio for a memo built from a Plaud transcript.
- Plaud Embedded (the partner SDK) and the `platform.plaud.ai` REST API, which need a client Plaud issues.
- Workspace-shared Plaud accounts; rules per project (one set per person per workspace).
- MCP write tools for the link or the queue.
- A cost estimate in the "Transcribe here" dialog: there is no configured per-minute price (doc 68).
- Audit actions for link and unlink.
- Marked `// ponytail:` in code:
  - the fixed 14-day lookback instead of a cursor (`plaud-rules.ts`);
  - a transcript read stops at 40 pages (20,000 utterances) and a listing at 5 pages (500 recordings)
    (`plaud.service.ts`);
  - a memo still being transcribed is not in `ai_usage` yet, so two quick presses of "Transcribe here" can
    pass the allowance by one recording (`memos.service.ts`).

## Verification

- Specs:
  - `test/plaud-oauth.spec.ts`: the parser, the off switch, forged state, sealed storage, a failed
    exchange, one refresh for two concurrent callers with the rotated token kept, a lapsed sign-in, unlink.
  - `test/plaud-import.spec.ts`: paging and units, the untranscribed and unlinked reads, the one-refresh
    retry, speaker masking and the secretary line, import with transcription off, idempotence including
    the race, every refusal, and "Transcribe here": its guards in order, the allowance arithmetic.
  - `test/plaud-queue.spec.ts`: the rules and defaults, `ask` never importing on its own, a yes before and
    after the transcript, a row holding only the listing, the final skip, the cap under a backlog, the
    sweeper's single claim, the role check, a deleted workspace, the keep-alive, the one reconnect notice,
    and that two `auto` sweeps never transcribe.
  - `apps/web/.../plaud-ui.spec.ts`.
- Throwaway live checks against a real Plaud account (not committed): the refresh, `get_current_user`,
  `list_files` with the date filter and paging, a 51-utterance transcript with a speaker on every segment
  and its last segment inside the recording's length, an untranscribed recording reading as empty, and the
  audio download with a byte ceiling failing the stream. They caught two parser bugs the mocks had hidden.
- The web panel in Chrome at 1280 and 390 px in Russian, against a local API with seeded rows: every queue
  group, the lapsed header, saving rules, skipping, and the "Transcribe here" numbers.
- **Not yet verified** (dogfood at release):
  - the browser round trip through `GET /v1/plaud/callback` with a client registered for a real
    `API_PUBLIC_URL`;
  - an import on a running API **and worker** through to merge requests, and a real `secretary` run
    reading speaker names;
  - "Transcribe here" on a worker (download → ffmpeg → speech server);
  - a notification reaching the inbox;
  - the acceptance criteria as a set against a non-admin person (dev mode is a platform admin).

## The project is per recording (#877)

`plaud_links.project_id` is the default, no longer the only destination. `plaud_imports.project_id` (nullable)
holds a person's choice for one recording; an import reads `row.projectId ?? link.projectId`. `confirm` and
`transcribe` take an optional `projectId` and write it onto the caller's open rows before anything else, so a
recording confirmed ahead lands in the project it was confirmed for even if the default changes meanwhile.

Only that the project belongs to the workspace is checked when the choice is written. Whether the person may
file into it is checked when the import runs (`MemosService.projectFor`), which can be days later: permission on
execution, not on offer. `auto` mode has no chooser, so it keeps using the default.

The panel shows a project select on each recording waiting for a yes and one for all of them, and always sends
the project a row shows.
