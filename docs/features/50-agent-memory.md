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
- **A capture key.** API keys have a third scope, `capture` ("Read & propose").
  It reads like a read-only key and can propose captures, but cannot write a
  page, merge, approve, sync, ingest or start a workflow. It can be pinned to
  projects (`projectIds`, up to 20).
- **The Captures inbox** (`/captures`, "Предложения агентов" in Russian) lists
  every capture by Staged, Proposed, Duplicates, Rejected and Failed. A row
  shows the agent, repository, branch and commit, what dedupe decided and the
  pages it was compared with. Terms are approved or rejected there. Page and
  relation captures link to their merge request.
- **Merge request provenance.** Every merge request records who opened it:
  `manual`, `agent` (an agent finding or an assistant proposal) or `captured`.
  The list badges it and filters on it, and a captured merge request's page
  shows the agent, repository, branch and session it came from.
- **Save to knowledge base** on an assistant reply that cites a page of this
  base. The reply is proposed as an `answer` capture.
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
The 0.92 / 0.80 defaults are **not calibrated** against backtest data yet. On
bge-m3 an end-to-end run put unrelated pages at about 0.55, well below amend.

**Terms go through the inbox, not a merge request.** A glossary term is a
row, not a revision, so there is nothing to merge. It waits `staged` with
outcome `glossary` until an editor approves it. Approval creates the
`GlossaryTerm` with `source: 'captured'` as the approver, and the capture then
reads `merged`. This is the one deliberate exception to "always a merge
request". The other option, a term created switched off in the glossary as
chat capture does, was considered and not chosen: the inbox keeps every
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
| Provenance strip, Save to knowledge base, settings panel | `components/merge-requests/MrProvenance.vue`, `assistant/ChatMessage.vue`, `ai/AiCapturePanel.vue` |
| Connect AI step 4                                        | `apps/web/src/pages/ConnectAiPage.vue`, `lib/mcp-clients.ts` (`captureKit`)                        |

## API

| Route                                                                  | Access                                                                        |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /v1/captures` (body discriminated by `kind`)                     | editor · body, `{ capture: true }`                                            |
| `GET /v1/captures?workspaceId&status&kind&projectId&mine&cursor&limit` | viewer · query; rows on pages or projects the caller cannot open are left out |
| `GET /v1/captures/:id`                                                 | viewer · capture (resolved in PG)                                             |
| `POST /v1/captures/:id/approve`                                        | editor · capture; terms only; a capture key is refused                        |
| `POST /v1/captures/:id/reject` `{ reason? }`                           | editor · capture; staged rows only; a capture key is refused                  |
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
  `content_hash`, session, `similar` (top hits kept for the reviewer), the
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

## Verification

- `test/captures.spec.ts`: dedupe outcomes, the 429 and its extras, credential
  refusal, a capture key unable to merge or approve, provenance on the merge
  request, and an idempotent re-post returning `duplicate`.
- `test/capture-inbox.spec.ts`: approve/reject roles, a capture key unable to
  approve, a cross-tenant 403, and the sweeper's recovery.
- `test/capture-templates.spec.ts`: en and ru rendering, frontmatter
  preserved.
- `test/capture-settings.spec.ts`: ceilings, overrides and the threshold
  order.
- `test/mcp-http.spec.ts`: the tool offer per key scope.
- `src/mcp/capture-kit.spec.ts`: a snapshot per client, the hook script is
  POSIX sh and fires once per session id, and the skill has no capture section
  for a read key.

**Not exercised:** the kit inside a live Claude Code or Cursor session; Connect
AI step 4 and the project pin with a bootstrapped key (both need
`AUTH_MODE=api-key`, and are typecheck- and unit-tested only); Save to
knowledge base on a live reply.

## Not done

- **Thresholds are uncalibrated.** The 0.92 / 0.80 defaults were chosen by
  judgement and one end-to-end run, not against `make backtest` data.
- **No integration.** An amend appends a deterministic section. It does not
  rewrite the page around the new fact. A drafter pass is the obvious next
  step.
- **No contradiction check.** A capture that disagrees with a page is
  proposed like any other. Catching that belongs to the bi-temporal knowledge
  graph milestone.
- **No auto-merge**, even for a trusted key. That waits for page verification
  to be the signal it would rest on.
- **No cleanup by key.** Revoking a key does not retract its open merge
  requests. The inbox filters by kind, project and "only mine", not by key, so
  a bad key's output is found by its owner's captures and rejected or closed
  one at a time.
- **No server-side distillation.** The agent decides what to capture. The
  platform never receives a transcript and has nothing to distill from.
- **Kits for two clients.** Codex, Gemini CLI and the rest get the skill's
  playbook without a reminder hook.
