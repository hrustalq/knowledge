# 50 — Agent memory: captured decisions and gotchas as reviewed merge requests

Issue [#73](https://github.com/hrustalq/knowledge/issues/73), shipped as five
PRs (#223–#227) and this document. Coding agents connected over MCP
([33](33-connect-ai.md)) could already **read** the knowledge base. What they
learned inside a session was lost when it ended: why an approach was picked,
the gotcha that cost an hour, the convention a reviewer insisted on. The only
way it reached the knowledge base was a person writing it up, and that mostly
did not happen.

Now the agent distills the session, and the platform stages the result, checks
it against what the knowledge base already says, and **proposes** it as a
merge request tagged `captured`. A person decides what becomes canonical.
Nothing a model writes reaches a default branch without review, the same rule
`AgentFindingsService` and `DocumentRelationsService.propose` already follow.

The difference from a memory layer such as Mem0 or Cognee is where captures
end up. They are reviewed, versioned and cited, and they live in the same
revision DAG and graph as the pages people write, not in a separate store.

## What

- **Five capture tools over MCP:**
  - `knowledge_capture_decision`: context, decision, consequences, alternatives
    and related pages.
  - `knowledge_capture_note`: `kind` is `gotcha`, `convention` or `howto`, with
    an optional `appliesTo` list of paths or entity keys.
  - `knowledge_propose_glossary_term`: a term, its definition and aliases.
  - `knowledge_propose_relation`: one frontmatter relation on a page.
  - `knowledge_propose_answer`: a question and its answer, citing at least one
    page.

  Two read tools go with them. `knowledge_find_similar` lets the agent check
  before capturing, and `knowledge_list_captures` shows where captures went.
  `POST /v1/captures` takes the same captures over REST.

- **Every capture carries a `session`** (`CaptureSession`): `client`,
  `clientVersion`, `sessionId`, `repo`, `branch`, `commit`, at most 20 `files`
  (paths only) and `startedAt`. Every field is the agent's own report. The
  server infers none of it and **never receives a transcript**.
- **A chat capture also carries an `origin`** (#82, `CaptureOrigin`):
  platform, chat title, thread link where there is one, and the time span of
  the messages. Its `session.client` is `chat`. Unlike the session it is set by
  the server from the chat delivery, through the third argument of
  `CaptureService.capture`; no request body and no model can supply it. The
  inbox row and the merge request show it, and a page gets it under
  `sources:` in its frontmatter.
- **A capture key.** API keys have a third scope, `capture` ("Read & propose").
  It reads like a read-only key and can propose captures, but cannot write a
  page, merge, approve, sync, ingest or start a workflow. It can be pinned to
  projects (`projectIds`, up to 20).
- **The Captures inbox** (`/captures`, "Предложения агентов" in Russian) lists
  every capture by Staged, Proposed, Duplicates, Rejected and Failed. A row
  shows the agent, repository, branch and commit, what dedupe decided and the
  pages it was compared with, and the key that wrote it. Terms are approved or
  rejected there. Page and relation captures link to their merge request.
- **Cleanup by key** (#235). A row's key, or "Its captures" on a key in Connect
  AI (offered again in the toast after revoking it), narrows the inbox to
  everything that key proposed. From there an editor turns down what is still
  pending in one act: staged captures are rejected and the open merge requests
  they opened are closed, after a confirmation that shows the server's own
  dry-run counts.
- **Merge request provenance.** Every merge request records who opened it:
  `manual`, `agent` (an agent finding or an assistant proposal) or `captured`.
  The list badges it and filters on it, and a captured merge request's page
  shows the agent, repository, branch and session it came from.
- **Save to knowledge base** on an assistant reply that cites a page of this
  base. The reply is proposed as an `answer` capture.
- **From chat** (#82). 💾 Save under a chat bot's answer is the same `answer`
  capture, or a `glossary` one ([47](47-chat-bots.md#saving-a-conversation)).
  A **harvest** has the `harvester` agent propose captures from a Telegram or
  Time thread a linked editor asked about, checked server-side before each is
  written ([59](59-chat-harvest.md)). Both are written as that person.
- **Settings → AI → Agent memory** (`/settings/ai/capture`): the switch, both
  rate limits, both dedupe thresholds and the parent page for new captured
  pages.
- **A capture kit** for Claude Code and Cursor. It installs a skill or rule
  that says what is worth capturing, and a hook that reminds the agent to
  capture at the end of a session that changed files. It is step 4 of Connect
  AI.

## How a capture becomes a proposal

`CaptureService.capture` (`apps/api/src/captures/capture.service.ts`) runs
**API-side, inside the MCP or REST request**, because that is where the
principal exists ("the worker generates, the API publishes"). No model is
called anywhere on the path.

1. **Guard.** `requireRole(…, 'editor', { capture: true })`. The workspace's
   capture switch must be on (403 `capture-disabled`).
2. **Stage the request.** Each kind resolves its project. A relation takes its
   page's project, and an answer takes its first cited page's unless it names
   one. The project must be in the workspace, inside the key's pin and not
   hidden from the writer (403 `capture-project-not-allowed`). Every linked
   page must exist and be readable by the writer. Otherwise the call fails with
   404 `capture-unreadable-pages`, which lists ids and never titles.
3. **Refuse what must not be stored**, before a row exists:
   - text over `CAPTURE_MAX_CHARS` (400 `capture-too-long`);
   - anything that looks like a credential (400 `capture-secret`, naming the
     pattern and never the value). `secret-scan.ts` checks the documented
     prefixes of knowledge keys, GitHub tokens, provider `sk-` keys, AWS, Google
     and Slack keys, private-key headers and JWTs.
4. **Rate limit.** Two counts over existing rows: the key's captures in the
   last hour, and the workspace's in the last day. A breach is 429
   `{ reason: 'capture-rate-limited', per, limit, retryAfterSec }`.
   `retryAfterSec` is when the oldest row leaves the window. A session
   principal has no key, so only the workspace limit applies to it.
5. **Exact dedupe.** `captureContentHash` hashes the kind, the normalized title
   and the payload with its keys sorted. The session is left out on purpose:
   two sessions capturing one fact are one fact. A match in the project, or a
   capture of the same kind and title still in flight, records a `duplicate`
   row pointing at what the first capture became, and proposes nothing. The
   row still counts against the rate limit, so a looping agent stops.
6. **Stage, claim, propose.** A `staged` row is inserted, then claimed with one
   guarded `updateMany`, then proposed by kind:
   - **Page kinds** (`decision`, `gotcha`, `convention`, `howto`, `answer`) are
     compared with existing pages by raw cosine over the vector leg alone,
     limited to the project and to pages the writer may open
     (`similarPages`):
     - top score ≥ the dedupe threshold **and** the same normalized title:
       `duplicate`, and nothing is proposed;
     - top score ≥ the amend threshold: **amend-page**, a `## Captured:
       <title>` section appended to that page;
     - otherwise **new-page**.

     An amend target the writer may only read becomes a new page instead,
     because a capture never proposes what its person could not.

     The text embedded is `dedupeText` (`capture-dedupe.ts`): the stored
     title, a blank line, then the main text (a note's body,
     `context\ndecision`, or `question\nanswer`). `knowledge_find_similar`
     embeds the same thing when it is given the `title` and `kind` the capture
     will carry, and runs the same `decide` (thresholds, then the edit check),
     so it answers `decision: duplicate | amend | new-page` exactly as the
     capture will (#233). Given only `text`, it embeds that text as is and
     returns no decision. The probe used to embed the bare body: in the
     v0.24.0 run a gotcha scored 0.8192 there and 0.7968 at capture, so the
     agent was told "amend" and the capture opened a new page.

   - **Relation:** `DocumentRelationsService.propose`, the same path a person's
     relation edit takes. A relation the page already declares is a
     `duplicate`.
   - **Glossary:** a term or alias the project already has, folded like an
     entity key, or one already waiting, is a `duplicate`. Otherwise the term
     waits in the inbox (below).

7. **Record.** The row becomes `proposed` inside the transaction that opened
   the merge request. If that settle misses, the merge request rolls back.
   `capture.proposed` goes to the activity feed. The tool returns
   `{ captureId, status, outcome, mergeRequestId?, webUrl, similar[] }`.

The page text comes from a fixed template per kind (`capture-templates.ts`),
headed in the writer's language. Workspaces have no locale, so the language is
`principal.locale`. New pages get a category per kind: decision →
architecture, gotcha and how-to → guide, convention → process, answer →
reference. Every captured revision appends to a `captured:` frontmatter list
`{ id, kind, client, sessionId, repo, commit, at }`, which records where the
text came from and never what the session said.

## Decisions

**A new page is created hidden, behind its merge request (Option A).** A
merge request needs a document to target. The capture creates the document
with no head on its default branch and puts the content on a `capture/…`
branch behind the merge request. `MergeRequestsService.merge` already accepted
a head-less target. The diff of one now renders every line as added
(`CompareService.compareWithNothing`, `compare.from: null`) instead of the old 400. While the merge request is open, `documents.pending_merge_request_id`
holds its id, and every surface that **enumerates** pages leaves the page out:
the tree, lists, knowledge health, export, published sites and `llms.txt`
(`LISTED_PAGE` / `listedSql`, `common/listed-page.ts`). The page stays
readable by id, so its reviewer can open it. The merge clears the marker in
the same transaction. A closed merge request leaves the empty stub hidden, not
archived, so a reopen still merges cleanly. The marker is deliberately not part
of `visibilityWhere`: that predicate decides who may open a page, and the
merge request list must keep showing the merge request whose page this is.
Chat saves ([47](47-chat-bots.md)) had created head-less pages in plain view.
They now set the marker too, and the migration backfilled theirs. The
alternative was no document until approval, staged in the inbox like a
connector `review` run. It would have meant a second review surface for page
text.

**Duplicate needs the same title, not just a close score.** A page about the
same subsystem scores high whatever new thing the capture says about it.
Dropping such a capture as a duplicate would lose exactly the knowledge this
exists to keep. A close score therefore amends, and only a restatement under
the same title is a no-op.

**Dedupe reads raw cosine.** The search score is `cosine × trustWeight` with
trust ranking on, and RRF on the fused path. No threshold means anything
against either, so `similarPages` embeds and calls `graph.searchChunks`
directly, folds chunk hits to the best chunk per page and post-filters in PG.
The 0.92 / 0.80 defaults are measured, not guessed: see
[§Calibration](#calibration).

**Terms go through the inbox, not a merge request.** A glossary term is a
row, not a revision, so there is nothing to merge. It waits `staged` with
outcome `glossary` until an editor approves it. Approval creates the
`GlossaryTerm` with `source: 'captured'` as the approver, and the capture then
reads `merged`. This is the one deliberate exception to "always a merge
request". The other option, a term created switched off in the glossary, as
chat Save did before #82, was considered and not chosen: the inbox keeps every
capture decision in one list. Page and relation captures cannot be decided in
the inbox. Approve answers 409 `capture-not-approvable`, and reject answers
409 `capture-use-merge-request` with `details.mergeRequestId`, so the merge
request is the single place they are decided. Reject works on any `staged`
row nobody holds a live claim on (otherwise 409 `capture-in-flight`), which
includes a page capture stranded before proposing.

**Merged and closed are derived, never stored.** `knowledge_captures.status`
holds only the states before or instead of a merge request: `staged`,
`proposed`, `duplicate`, `rejected` and `failed`. `captureStateFor(status,
mrStatus, glossaryTermId)` reads `merged` or `closed` from the merge request
itself, so the capture row and the merge request can never disagree.

**What proposes a capture never decides it.** A `capture` key passes `editor`
only on calls flagged `{ capture: true }`, and only the capture tools and
`POST /v1/captures` pass that flag. Approve, reject, merge and approving a
merge request are not flagged, so `requireRole` refuses the key there. A
captured merge request is authored by the key's owner, so the merge gate's
self-approval rule already excludes that person's own approval
([33 §Decisions](33-connect-ai.md#decisions)).

**`CAPTURE_TOOLS` is kept apart from `WRITE_TOOLS`.** A tool is a write when
it is in either list. A spec asserts the two are disjoint and that both name
only registered tools. A write key is offered both lists, a capture key the
reads plus `CAPTURE_TOOLS`, and a read key the reads only. `renderSkill`'s
edit flow ignores capture tools, so a capture key is never shown the branch →
revision → merge request playbook. It gets the "Capture memory" section
instead.

**The project pin narrows writes, not reads.** `api_keys.project_ids` is a
JSON list, null meaning every project. It is accepted only on capture keys,
because on another scope it would be a setting that does nothing.
`CaptureService` enforces it. Reads through the key are not narrowed: the
agent still needs the rest of the workspace for context.

**Stored scope parsing fails closed.** `apiKeyScopeOf` reads an unknown stored
value as `read`. The previous `=== 'read' ? 'read' : 'write'` would have turned
every capture key into a write key on an older reader.

**A crashed capture is finished, not lost.** An API restart between staging
and proposing leaves a `staged` row. `CaptureSweeper` (API-only, in
`CapturesModule`) re-drives such rows on a fixed tick with back-pressure, as
their writer (`AccessService.principalFor`), once a claim is older than
`CAPTURE_STALE_MS`. A 4xx, or a third failed attempt (`CAPTURE_MAX_ATTEMPTS`),
marks the row `failed`. A term waiting in the inbox is staged on purpose, and
neither the claim nor the sweeper touches it. The sweeper must not sit in
`CapturesCoreModule`, which MCP loads. The dependency rule
`mcp-loads-no-sweeper` enforces this.

**Answers stand on their citations.** `knowledge_propose_answer` and Save to
knowledge base refuse an answer that cites no page (400
`capture-no-citations`). An answer goes through the page dedupe like any
other page kind, so it amends the closest page or starts a new one. There is
no separate FAQ page. The assistant route builds the capture from
`AssistantMessage.content` and `sources`, with the question before it, client
`assistant`, and the `[S#]` labels stripped.

## The capture kit

Capturing depends on the agent choosing to do it, and the end of a session is
when it forgets. The kit puts the reminder there.

`GET /v1/mcp/capture-kit?client=claude-code|cursor` returns the files
(`CaptureKitResponse`) and `GET /v1/mcp/capture-kit/install?client=…` returns
a POSIX installer for `curl … | sh`. Both are generated for the caller, like
`/v1/mcp/skill`. A credential that is offered no capture tool, such as a
read-only key, gets 403 `capture-not-offered`, which is the same predicate the
skill uses. Other clients get 400. Their guidance is the generated skill's
"Capture memory" section, with no reminder.

| Client      | Files                                                                                                                                                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `.claude/skills/knowledge-capture/SKILL.md`, `.claude/hooks/knowledge-capture.sh`, and hook entries merged into `.claude/settings.json`: `PostToolUse` on `Edit\|Write\|MultiEdit\|NotebookEdit` runs `edited`, `Stop` runs `stop` |
| Cursor      | `.cursor/rules/knowledge-capture.mdc` (agent-requested: `alwaysApply: false`, no globs), `.cursor/hooks/knowledge-capture.sh`, and `.cursor/hooks.json` with `afterFileEdit` → `edited`, `stop` → `stop`                           |

The hook does exactly this:

- **It holds no key and calls nothing.** It only prints a reminder. The model
  does the capturing, through the MCP server it is already connected to.
- **`edited`** writes a marker `$TMPDIR/knowledge-capture/<id>.edited`
  (falling back to `/tmp`), where `<id>` is Claude Code's `session_id` or
  Cursor's `conversation_id` from the hook's stdin. The markers sit outside
  the repository, so the working tree never shows them.
- **`stop`** does nothing unless that marker exists, so a session that changed
  no file is never reminded. It then creates `<id>.reminded` with `mkdir`,
  which is atomic, so only the first stop of a session reminds and every later
  one is silent.
- **The reminder** asks the model to record any decision, gotcha, convention
  or hard-won answer with the kit's skill or rule, passing `session.client` and
  `session.sessionId`. It tells the model to call `knowledge_find_similar`
  first with the title and kind it will capture with and to skip a
  `duplicate` (kit v2), never to include secrets, and to say so in one line if nothing is
  worth keeping.
  - Claude Code receives it as `hookSpecificOutput.additionalContext` on
    `Stop`, not `decision: "block"`. Claude Code's docs recommend this for
    guidance, and it shows as hook feedback rather than an error.
  - Cursor receives it as `followup_message`, only on a `completed` turn. A
    follow-up on an aborted or failed turn would answer the person's
    interruption with a chore.
- **A session id outside `[A-Za-z0-9._-]{1,200}` counts as no id** and the hook
  stays silent. The id becomes a file name and lands in printed JSON, so it is
  matched against a closed alphabet first.
- "The session made edits" comes from the marker alone. The transcript is not
  parsed.

The installer refuses to run outside a git repository and installs at its
root. It overwrites the skill or rule and the script. It **never overwrites**
`.claude/settings.json` or `.cursor/hooks.json`. With `jq`, it merges the
kit's entries in, first dropping any earlier entry whose JSON mentions
`knowledge-capture.sh`, so re-running updates without duplicating. Without
`jq`, it prints the entries for the person to add. The kit's own skill lists
the workspaces and projects the caller may capture into, with the key's pin
applied, and names no person, so a team can commit it. `CAPTURE_KIT_VERSION`
(currently 1) is printed in every installed script. Bump it when a vendor
changes its hook contract; re-fetching is how a kit updates.

`knowledge_whoami` returns `apiKey.projectIds`, and the generated skill's key
line names the pin.

## Where it lives

| Piece                                                    | File                                                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Vocabulary, request/response types, `captureStateFor`    | `packages/contracts/src/captures/index.ts`                                                         |
| Stage, guard, dedupe, propose, list                      | `apps/api/src/captures/capture.service.ts` (`CapturesCoreModule`, loaded by MCP)                   |
| Hashing, title folding, the page decision                | `apps/api/src/captures/capture-dedupe.ts`                                                          |
| Page templates, `captured:` frontmatter                  | `apps/api/src/captures/capture-templates.ts`, `i18n/{en,ru}/capture.json`                          |
| Credential shapes                                        | `apps/api/src/captures/secret-scan.ts`                                                             |
| REST, inbox approve/reject, assistant write-back         | `captures.controller.ts`, `capture-inbox.service.ts` (`CapturesModule`, API-only)                  |
| Crash recovery                                           | `apps/api/src/captures/capture.sweeper.ts`                                                         |
| MCP tools                                                | `apps/api/src/mcp/capture-tools.ts`; `CAPTURE_TOOLS` in `mcp-tools.ts`                             |
| Capture kit, playbook                                    | `apps/api/src/mcp/capture-kit.ts`; the skill section in `skill.ts`                                 |
| Settings resolution (ceiling, override)                  | `apps/api/src/ai/capture-settings.ts`, `AiConfigService.captureSettings`                           |
| Key scope                                                | `AccessService.requireKeyAllows`, `apiKeyScopeOf` (contracts)                                      |
| Hidden head-less pages                                   | `apps/api/src/common/listed-page.ts`, `documents/draft-merge-request.ts`                           |
| Inbox                                                    | `apps/web/src/pages/CapturesPage.vue`, `components/captures/`                                      |
| Chat Save and harvest (#82)                              | `apps/api/src/chat/chat-captures.service.ts`, `chat/harvest.service.ts`                            |
| Provenance strip, Save to knowledge base, settings panel | `components/merge-requests/MrProvenance.vue`, `assistant/ChatMessage.vue`, `ai/AiCapturePanel.vue` |
| Connect AI step 4                                        | `apps/web/src/pages/ConnectAiPage.vue`, `lib/mcp-clients.ts` (`captureKit`)                        |

## API

| Route                                                                  | Access                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/captures` (body discriminated by `kind`)                     | editor · body, `{ capture: true }`                                            |
| `GET /v1/captures?workspaceId&status&kind&projectId&mine&apiKeyId&cursor&limit` | viewer · query; rows on pages or projects the caller cannot open are left out; `apiKeyId` of another person's key takes an editor, a key from another tenant 403s |
| `GET /v1/captures/:id`                                                 | viewer · capture (resolved in PG)                                             |
| `POST /v1/captures/:id/approve`                                        | editor · capture; terms only; a capture key is refused                        |
| `POST /v1/captures/:id/reject` `{ reason? }`                           | editor · capture; staged rows only; a capture key is refused                  |
| `POST /v1/captures/bulk-reject` `{ workspaceId, apiKeyId, reason?, dryRun? }` | editor · body; a capture key is refused; returns `{ rejected, closed, skippedInFlight, skippedNoAccess }` |
| `POST /v1/assistant/messages/:id/capture` `{ projectId?, title? }`     | editor · assistant-message, `{ capture: true }`                               |
| `GET /v1/mcp/capture-kit?client=` · `…/capture-kit/install?client=`    | authenticated; 403 `capture-not-offered` for a read key                       |
| `GET /v1/merge-requests?provenance=`                                   | the existing list, filtered                                                   |
| `POST /v1/me/api-keys` `{ scope: 'capture', projectIds? }`             | session only; a pin on another scope is refused                               |

Activity actions `capture.proposed`, `capture.approved` and `capture.rejected`
derive to `curate` and drive the live `capture.*` frames, which refresh the
inbox. `merge-request.*` frames refresh it too, because merged and closed are
the merge request's state.

## Data

- `knowledge_captures`: kind, stored status, outcome, title, payload,
  `content_hash`, session, `origin` (chat captures only, #82), `similar` (top hits kept for the reviewer), the
  target page, merge request or term, `api_key_id`, `created_by`, `attempts`,
  `claimed_at`, and error. CHECKs on kind, status and outcome. No FK on
  workspace, project or creator (house policy).
- `merge_requests.provenance` (default `manual`, CHECK) and `capture_id`.
- `api_keys.project_ids`.
- `documents.pending_merge_request_id`.
- Six nullable `ai_settings` columns: the sparse overrides below.

Migrations `20261028100000_agent_captures` and
`20261029100000_capture_pending_pages` are additive. The second backfills
merge requests from agent findings as `agent` and from chat saves as
`captured`, and hides chat-saved pages whose merge request has not merged.
`20261117100000_chat_captures_into_agent_memory` (#82) adds `origin`, copies
the old `chat_captures` rows in under their own ids and drops that table; it
is not reversible.

## Configuration

All have defaults. The switch and the two limits are **ceilings**: the
workspace setting can only lower them, and the settings page shows what was
asked beside what applies. The thresholds are overrides, and amend ≤ dedupe is
enforced both on save and on read. A workspace that sets nothing behaves
exactly as the env says.

| Var                             | Default  | Meaning                                                       |
| ------------------------------- | -------- | ------------------------------------------------------------- |
| `CAPTURE_ENABLED`               | `true`   | Global switch                                                 |
| `CAPTURE_PER_KEY_PER_HOUR`      | `30`     | Captures per API key in a rolling hour                        |
| `CAPTURE_PER_WORKSPACE_PER_DAY` | `500`    | Captures per workspace in a rolling day                       |
| `CAPTURE_DEDUPE_THRESHOLD`      | `0.92`   | Cosine at or above which a same-titled capture is a duplicate |
| `CAPTURE_AMEND_THRESHOLD`       | `0.8`    | Cosine at or above which a capture amends the nearest page    |
| `CAPTURE_MAX_CHARS`             | `8000`   | Title and payload text, together                              |
| `CAPTURE_SWEEP_INTERVAL_MS`     | `60000`  | Sweeper tick                                                  |
| `CAPTURE_STALE_MS`              | `300000` | A claim older than this is re-driven                          |

The workspace's parent page for new captured pages applies only when it is a
live page of the capture's project. Otherwise the page is created at the
project root.

## Calibration

`make backtest ARGS="--captures --workspace <id>"` measures the two
thresholds on a workspace's own pages (#234). It reads only. For each page
with a removable section and a lead paragraph it builds four labelled cases,
scored the way `similarPages` scores a capture: raw cosine, best chunk per
page, pages of the same project.

| Class               | Probe (title + text)       | Scored against                    | Right answer |
| ------------------- | -------------------------- | --------------------------------- | ------------ |
| amend               | section heading + section  | its page without that section     | amend it     |
| new page            | the same probe             | every other page (its page gone)  | new page     |
| restatement         | page title + lead          | its whole page                    | duplicate    |
| same-title new fact | page title + section       | its page without that section     | amend, never drop |

Chunks never cross a heading, so dropping a section's chunks removes exactly
that section. A section is sampled only if it is one chunk, at least 200
characters, and its heading is not a **template slot**, meaning a heading at
least 3 pages share ("Foreign keys", "Preconditions"). A templated corpus
fills a slot with near-identical text on every page, so the slot scores
closer to its siblings than to its own page, and no capture reads like one.
The script then prints p5/p50/p95 per class and, for every threshold from
0.50 to 0.98, the share of each class it gets wrong. `--verbose` lists every
case with its nearest other page. `--reembed` embeds the corpus as well as
the probes with whatever provider the env configures, so another model is
measured without reindexing anything:
`EMBEDDINGS_PROVIDER=stub EMBEDDINGS_DIM=768` for the stub production runs,
or a candidate replacement before switching to it.

**Run of 2026-10-16**, demo workspace (492 live pages, one project, mostly
Russian OMS specifications), 90 cases, 47 template headings left out. This
run read the corpus through `liveChunks` while it still stopped at 5,000
chunks. The workspace had 5,936 chunks matching the live predicate, so about
one chunk in six was left out. Since #304 `liveChunks` reads every chunk, and
the run has not been repeated yet:

| Class (p5 / p50 / p95)  | bge-m3, 1024-d (stored) | stub, 768-d (re-embedded) |
| ----------------------- | ----------------------- | ------------------------- |
| amend                   | 0.558 / 0.759 / 0.881   | 0.119 / 0.445 / 0.925     |
| new page                | 0.597 / 0.720 / 0.866   | 0.299 / 0.500 / 0.908     |
| restatement             | 0.748 / 0.971 / 1.000   | 0.371 / 0.973 / 1.000     |
| same-title new fact     | 0.665 / 0.826 / 0.920   | 0.124 / 0.501 / 0.934     |

Errors on bge-m3. Amend: *scattered* means a new page instead, *wrong page*
means another page outranks its own, *false amend* means an unrelated page
gains a section. Dedupe: *missed* means a redundant section is proposed,
*dropped* means new knowledge is silently lost.

| Amend | scattered | wrong page | false amend | sum    |
| ----- | --------- | ---------- | ----------- | ------ |
| 0.76  | 35.6%     | 24.4%      | 35.6%       | 95.6%  |
| 0.78  | 46.7%     | 18.9%      | 27.8%       | 93.3%  |
| 0.80  | 58.9%     | 15.6%      | 20.0%       | 94.4%  |
| 0.84  | 80.0%     | 7.8%       | 7.8%        | 95.6%  |

| Dedupe | missed | dropped | sum   |
| ------ | ------ | ------- | ----- |
| 0.88   | 22.2%  | 12.2%   | 34.4% |
| 0.90   | 27.8%  | 7.8%    | 35.6% |
| 0.92   | 32.2%  | 4.4%    | 36.7% |

**The defaults stay at 0.92 / 0.80.** With 90 cases one case is 1.1 points.
The unweighted optimum (amend 0.78, dedupe 0.88) beats the defaults by one
and two cases, which is inside the noise. Within that band each default errs
toward the cheaper mistake. A scattered capture is a new-page merge request
that lists the similar pages, so its reviewer can redirect it. A false amend
edits a page that had nothing to do with it. A missed restatement is a merge
request someone rejects. A drop proposes nothing, so nobody ever reviews it,
and 0.88 drops nearly three times as often as 0.92.

What the run says beyond the two numbers:

- **The amend decision is limited by ranking, not by the threshold.** On a
  single-domain corpus another page outranks the section's own page in 43% of
  amend cases at any threshold up to 0.58, and the amend and new-page
  distributions overlap almost entirely. No threshold gets the sum under 90%.
  The new-page labels are noisy too: the best other page in a corpus like this
  is often a genuine sibling.
- **The restatement is an upper bound.** Its probe is the page's verbatim
  lead. A paraphrase scores lower and is missed more often.
- **The stub cannot make the amend decision.** A section scores a median 0.445
  against its own page and 0.500 against the nearest other one, and every amend
  threshold sums to 100% or more. Production ran the stub until 2026-10-18,
  when #257 moved it to bge-m3 (see the second production run below). For a stub
  workspace the run suggests a dedupe override of 0.78. It drops no more than
  0.92 (6.7%) and misses 23.3% of restatements instead of 40%. Amend then
  follows it down to 0.78, which on the stub is no worse than 0.80 (107.8%
  both). The real fix is a real embedding model.

**Production run of 2026-10-17** (v0.26.0, inside the `api` container on the
production host, stored stub vectors). Only one workspace has 20 or more live
pages: RTech OMS, with 31 pages, 23 cases and 11 template headings left out.
With 23 cases, one case is 4.3 points.

| Class (p5 / p50 / p95) | stub, 768-d (stored)  |
| ---------------------- | --------------------- |
| amend                  | 0.128 / 0.274 / 0.405 |
| new page               | 0.282 / 0.458 / 0.664 |
| restatement            | 0.558 / 0.974 / 0.990 |
| same-title new fact    | 0.173 / 0.299 / 0.491 |

| Dedupe | missed | dropped |
| ------ | ------ | ------- |
| 0.78   | 8.7%   | 0.0%    |
| 0.88   | 13.0%  | 0.0%    |
| 0.92   | 17.4%  | 0.0%    |

It confirms the stub finding on a corpus nobody tuned against:

- **Production never amends.** No section scores above 0.44 against its own
  page. At 0.80 every amend case scatters (100%) and none lands on a wrong page.
  Each capture therefore becomes a new-page merge request that lists the
  similar pages, which is the cheap error. In 21 of the 23 cases another page
  outranks the section's own, so lowering amend would mostly put sections on
  the wrong page: 39% wrong page at 0.50.
- **0.78 is still the dedupe override to use.** It halves the missed
  restatements (2 cases instead of 4) and drops nothing here: same-title new
  facts score a p95 of 0.49. On the demo corpus it also dropped no more than
  0.92 did (6.7%).

The override is a workspace capture setting and has not been applied.

**Production run of 2026-10-18** (v0.27.0, after #257 moved production to
bge-m3 served by Ollama on the host and reindexed every branch head). Same
command, same workspace, and the same 23 cases and 11 template headings.

| Class (p5 / p50 / p95) | bge-m3, 1024-d (stored) | stub, 768-d (2026-10-17) |
| ---------------------- | ----------------------- | ------------------------ |
| amend                  | 0.569 / 0.668 / 0.762   | 0.128 / 0.274 / 0.405    |
| new page               | 0.582 / 0.701 / 0.829   | 0.282 / 0.458 / 0.664    |
| restatement            | 0.883 / 0.979 / 0.990   | 0.558 / 0.974 / 0.990    |
| same-title new fact    | 0.620 / 0.732 / 0.800   | 0.173 / 0.299 / 0.491    |

| Amend | scattered | wrong page | false amend | sum    |
| ----- | --------- | ---------- | ----------- | ------ |
| 0.76  | 56.5%     | 34.8%      | 34.8%       | 126.1% |
| 0.80  | 73.9%     | 21.7%      | 21.7%       | 117.4% |
| 0.84  | 100.0%    | 0.0%       | 0.0%        | 100.0% |

| Dedupe | missed | dropped | sum   |
| ------ | ------ | ------- | ----- |
| 0.78   | 0.0%   | 13.0%   | 13.0% |
| 0.84   | 0.0%   | 0.0%    | 0.0%  |
| 0.88   | 4.3%   | 0.0%    | 4.3%  |
| 0.92   | 17.4%  | 0.0%    | 17.4% |

- **Amend now fires, but on this corpus it does worse than never amending.**
  At 0.80, 6 of the 23 amend cases clear the threshold, against none on the
  stub. Only one of them lands on its own page, though: the other 5 go to the
  wrong page, and 5 unrelated pages would gain a section. The sum, 117.4%, is
  worse than the stub's 100%, and
  the demo corpus's ~93% was not reached. The cause is the one the demo run
  found, only sharper. Another page outranks a section's own page in 17 of 23
  cases (21 on the stub), and the new-page median (0.70) sits above the amend
  median (0.67). Many RTech OMS pages are still scaffolds with placeholder
  slots (`_заполнить_`), so what remains of a page looks like its siblings.
  The Demo Workspace has 5 live pages and was not measured. Only from
  0.84 up does amend stop firing, which is where the unweighted optimum lands.
- **The 0.78 dedupe override above is now wrong.** On bge-m3 it drops 13% of
  same-title new facts (3 cases), where 0.92 drops none. It was a stub-only
  workaround and was never applied.
- **Dedupe at 0.92 misses as many restatements as the stub did** (17.4%, 4
  cases) and drops nothing. 0.84 scores no errors here, but with 23 cases that
  is a 4-case difference, inside the noise. On the demo corpus, lowering
  dedupe cost drops.

**The defaults stay at 0.92 / 0.80.** Changing thresholds was out of scope for
#257. Whether RTech OMS should amend at all while its pages are mostly
template text is a separate decision. A workspace amend override of 0.84 or
higher stops amending there.

To re-run after changing the embedding model, run the same command and
compare against these tables. Run one backtest at a time, because ArcadeDB
runs out of memory on concurrent scans.

`make tune ARGS="--workspace <id>"` (#305) reads the same probes and proposes
a workspace override for either threshold. It moves one only when the error
sum falls on a train split and a 30 % holdout, and the costly error (a dropped
new fact for dedupe, a false amend for amend) does not grow. It prints the
`PATCH /v1/ai/settings` body and writes nothing. See
[55 — Learning loop](55-learning-loop.md#make-tune).

## Verification

- `test/captures.spec.ts`: dedupe outcomes, the 429 and its extras, credential
  refusal, a capture key unable to merge or approve, provenance on the merge
  request, and an idempotent re-post returning `duplicate`.
- `test/capture-inbox.spec.ts`: approve/reject roles, a capture key unable to
  approve, a cross-tenant 403, and the sweeper's recovery. For #235: the key
  filter's editor rule and tenant check, and bulk reject rejecting staged rows,
  closing open merge requests, leaving merged ones and skipping in-flight rows
  and read-only pages, with one activity row per capture and a dry run that
  writes nothing.
- `test/capture-templates.spec.ts`: en and ru rendering, frontmatter
  preserved.
- `test/capture-settings.spec.ts`: ceilings, overrides and the threshold
  order.
- `test/capture-calibration.spec.ts`: which section stands in for a capture
  (never a template slot, never the page's only section, the same one every
  run), the section left out of its own page's score, and each error share.
- `test/mcp-http.spec.ts`: the tool offer per key scope.
- `src/mcp/capture-kit.spec.ts`: a snapshot per client, the hook script is
  POSIX sh and fires once per session id, and the skill has no capture section
  for a read key.

**Not exercised:** the kit inside a live Claude Code or Cursor session; Connect
AI step 4 and the project pin with a bootstrapped key (both need
`AUTH_MODE=api-key`, and are typecheck- and unit-tested only); Save to
knowledge base on a live reply.

## Not done

- **No integration.** An amend appends a deterministic section. It does not
  rewrite the page around the new fact. A drafter pass is the obvious next
  step.
- **No contradiction check.** A capture that disagrees with a page is
  proposed like any other. Catching that belongs to the bi-temporal knowledge
  graph milestone.
- **No auto-merge**, even for a trusted key. That waits for page verification
  to be the signal it would rest on.
- **Revoking does not reject.** Revoking a key stops new captures and leaves
  its pending ones for review, because a revoked key's past output may still
  be good. Cleanup by key (above) is one deliberate step away.
- **Merged captures stay merged.** Bulk reject leaves them alone; undoing one
  is an ordinary revert merge request.
- **No server-side distillation.** The agent decides what to capture. The
  platform never receives a transcript and has nothing to distill from.
- **Kits for two clients.** Codex, Gemini CLI and the rest get the skill's
  playbook without a reminder hook.
