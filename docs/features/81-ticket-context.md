# 81 — Ticket context: pointers for an agent starting a ticket

Milestone [#1193](https://github.com/hrustalq/knowledge/issues/1193), phases
[#1194](https://github.com/hrustalq/knowledge/issues/1194) (the tool),
[#1195](https://github.com/hrustalq/knowledge/issues/1195) (measurement),
[#1196](https://github.com/hrustalq/knowledge/issues/1196) (the hook nudge),
[#1197](https://github.com/hrustalq/knowledge/issues/1197) (the skill step, Connect AI, this doc). It builds on
[33 — Connect AI](33-connect-ai.md), [50 — Agent memory](50-agent-memory.md) (the capture kit) and
[80 — Memory banks](80-memory-banks.md) (project banks).

## What

A coding agent that picks up a ticket starts blind. The workspace may already hold the runbook, the glossary term and
last week's agent note that settle half the task, but the agent finds them only if someone tells it to search or
pastes the pages in. Pasting is worse than nothing: a session that opens with five copied documents spends its context
on text it mostly will not use.

The rule: **push a map, pull the territory.** One cheap call names what the workspace knows about the ticket and why it
matched, inside a hard token budget. Anything deeper is one existing tool call away (`knowledge_get_document_content`,
`knowledge_search`). Nothing is handed over that the caller's key could not read itself.

```
ticket read in Claude Code / Cursor ─ hook (no key, no network) ─▶ "call knowledge_context once"
any other client ─────────────────── skill "Starting a ticket" ──▶ "call knowledge_context once"
                                                                     │
knowledge_context / POST /v1/context ─▶ ContextService.context      ▼
   ├─ SearchService.search (groupBy page, caller's scope)  → pages, trust status, ≤ 200-char excerpt
   ├─ glossary rows of the repo's projects + workspace     → terms the query names
   ├─ MemoryRuntimeService.recallProjects                  → project-bank memory, unverified
   ├─ packContext: budget, whole items, floors             → the answer
   └─ AnalyticsRecorder.search(mode 'context', tokens)     → Usage analytics → Agents
```

## The tool

`knowledge_context` (MCP, `core` toolset, read-only) and `POST /v1/context` (`@Access('viewer', 'body')`, no guests)
take `{ workspaceId, query, repo?, projectIds?, exclude?, budget? }` and answer `ContextResponse`
(`@knowledge/contracts`): `pages`, `memories`, `terms`, the `projectIds` memory was read from, `tokens`, `empty` and,
when empty, `reason: 'nothing-relevant'`. No model call: the search's one embedding, then SQL.

- **`query`** is condensed by the model: the ticket's title and key terms in the ticket's language, not the raw
  ticket. A whole ticket as a query matches everything a little.
- **Pages**, at most 4 (`CONTEXT_LIMITS`), are workspace-wide: the same hybrid search, ACL and trust re-rank as
  `knowledge_search`, one result per page. Each carries `title`, `documentId`, `status` (the page's
  `verificationStateFor`), `match` (the longest query word the best chunk matched; absent for a match on meaning
  alone) and `excerpt`: at most `CONTEXT_EXCERPT_CHARS` (200) of the best chunk, plain text. Outdated and expired pages
  are shown, flagged by `status`, and rank below verified ones because the trust weighting already puts them there.
  Archived pages are absent.
- **Terms**, at most 3: glossary terms whose headword (or alias, where the term links aliases) occurs in the query as a
  word, with the glossary's own boundaries (`GLOSSARY_BOUNDARY_*`), case where the term is case-sensitive, longest
  spelling first so a longer term claims its words before a shorter one inside it. The vocabulary is
  `effectiveGlossary` per resolved project (a project term replaces the workspace's), or the workspace's own terms when
  no project resolved. Each carries its first definition line, shortened, and the page that defines it.
- **Memories**, at most 3, from the **project banks** (`project:<id>`) of the resolved projects, through
  `MemoryRuntimeService.recallProjects`: the runtime's own caller check (memory section on, viewer), `MemoryAccessService
  .visible` on the caller's scope, `runtimeBank(…, { create: false })` (a missing or squatted bank is skipped), recall
  with observations preferred. Each is `status: 'unverified'` with its `bankId` and date. **No personal bank is read**:
  a CLI caller has no runtime personal bank (those are `agent:<key>:user:<id>`, written by in-app turns).
- **`exclude`** skips page, term and memory ids an earlier call showed, so a second call does not repeat itself.

### Repo → projects

`repo` is a git remote in any common form: `git@github.com:Org/Repo.git`, `https://github.com/org/repo`,
`ssh://git@host/org/repo.git`. `repositorySegments` (`apps/api/src/components/component-match.ts`, the folding
component pages already use, which now also reads the scp form) folds each to `host/owner/repo`, lower case, no `.git`.
A project matches when one of its `codebase` or `markdown-git` connectors has a `repoUrl` that folds to the same
segments; several projects may match. `projectIds` adds projects directly. Either way, a project is kept only when it is
this workspace's and `canSeeProject` passes for the caller: a restricted project's id is never echoed back, and its bank
and terms are never read for someone outside it.

### Budget and floors

The answer is measured as the MCP tool renders it — the facts line plus the untrusted `<documents>` block, through
`pageText` — with `estimateTokens`. That includes the wrapper's fixed preamble (about 75 tokens), so the number is what
the agent pays.

- `budget` defaults to 1200 and is clamped to 600–4000 (`CONTEXT_BUDGET`, #1211). The minimum fits the wrapper and
  all four pages with full excerpts (about 500 tokens with 80-character titles); the default fits a full answer
  (4 pages, 3 memories, 3 terms: about 900 tokens on prod, about 1070 with every field at its longest), so on today's
  limits the budget never drops an item that passed its floor. The tool is called
  once per ticket: a few hundred extra tokens there cost less than an agent searching again for what was dropped.
  `context.spec.ts` pins both claims with worst-case items.
- `packContext` fills pages, then memories, then terms. An item that would push the answer over the budget is dropped
  whole and the next one is tried; nothing is cut mid-item. One page costs about 100 tokens. A caller that passes a
  smaller budget still gets this order.
- **Floors on every section.** A page whose best chunk the vector leg found needs a cosine of at least
  `MEMORY_RUNTIME_MIN_SEMANTIC` (0.4 on bge-m3; one env value for both, the same embedder). A page only BM25 found
  already matched a share of the query's terms (#400). A memory must have passed the semantic floor: the memory
  keyword leg ORs the query's words, so on a ticket-length query it matches nearly anything. A term must occur in the
  query.
- When nothing passes, the answer is one plain JSON line with `empty: true, reason: 'nothing-relevant'` and no wrapper,
  never low-scoring filler.

## The nudge (hooks)

The capture kit ([50](50-agent-memory.md#the-capture-kit), v3) installs the nudge beside the capture reminder, in the
same `knowledge-capture.sh`. It still **holds no key and makes no network call**: it prints about 40 tokens telling the
model to call `knowledge_context` once, with the ticket's title and key terms, the repo remote and the ids already
shown.

| Client      | When                                                                                                                                                             | How                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Claude Code | `PostToolUse` on `Bash` running `gh\|glab\|jira issue view …`, or on a tracker MCP tool (`TICKET_TOOL_MATCHER`); `UserPromptSubmit` whose prompt names a ticket | `hookSpecificOutput.additionalContext`                 |
| Cursor      | `postToolUse` after the same shell commands or a tracker MCP tool                                                                                                | `additional_context`                                   |
| Cursor      | a ticket pasted as a message                                                                                                                                     | none: `beforeSubmitPrompt` cannot add context; the skill covers it |
| Codex, Kimi, Claude Desktop, any MCP client | —                                                                                                                                | the skill's "Starting a ticket" step                   |

- Checked live per client in [33 §Client checks](33-connect-ai.md#client-checks): Claude Code passes on v0.61.0; Kimi
  Code CLI 2.6.3 never let its model call an MCP tool (#1341); a Bash command that reads two tickets nudges only for
  the first (#1340).
- The ticket is read from the tool's **input** only, never its output, which can name any number of other tickets; from
  the prompt, only text after `"prompt"`, so a path in `cwd` is not read as a ticket.
- A ticket is the first of: a tracker URL (`/issues/N`, `/browse/KEY`, `/issue/KEY`), `owner/repo#N`, a `KEY-123` that
  is not a standard (`UTF-8`, `ISO-8601`, `SHA-256`), or the number after `issue view`. It is folded to a key of
  `[A-Za-z0-9_-]`, at most 64 characters.
- **Once per ticket per session**: the first nudge creates `$TMPDIR/knowledge-capture/<session>.ticket.<key>` with
  `mkdir`, which is atomic; every later read of the same ticket, by tool or prompt, is silent.
- A credential offered no capture tool gets no kit (doc 50), so no hook; its skill still has the step.

## The skill step

`renderTicketStep` (`apps/api/src/mcp/skill-sections.ts`) is a `core` section, placed before "Answer a question from the
knowledge base" and rendered only when the caller is offered `knowledge_context`, so a caller who is not reads a skill
byte-identical to the one before this feature (pinned in `test/mcp-http.spec.ts`). It tells the model to call the tool
first, open a page only when the task needs it, treat memory as unverified, and call again with `exclude` only when the
task turns to something new.

**Connect AI** (step 4, beside the capture kit) shows what the nudge does for the picked client, the Cursor caveat, and
the step itself, cut from the SKILL.md the page already fetched: the text an agent reads, never a second copy.

## Measurement

Every call is a `search_queries` row with `mode = 'context'`, `result_doc_ids` = the pages handed over,
`result_count` = pages + memories + terms (so 0 means nothing relevant) and the nullable `result_tokens` (migration
`20270202100000`, additive). `AnalyticsQueryService.context` rolls them up at read time, per UTC day and channel and
over the window, into `GET /v1/analytics/agents` → `context`, shown under **Usage analytics → Agents**:

- **injections** and **median tokens**;
- **empty rate**: injections with `result_count = 0`;
- **follow-up rate**: injected pages the same API key (or, without a key, the same reader) opened over the same channel
  within `CONTEXT_FOLLOW_UP_HOURS` (2) — through `knowledge_get_document*`, which records an MCP page view. MCP over
  HTTP is stateless and carries no session id, so key + time window is the whole attribution.

Context rows are kept out of the search dashboards and `knowledge_list_search_gaps`: a ticket handed to an agent is not
a search a person ran.

## Where it lives

| Piece                       | File                                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Service, packing, matching  | `apps/api/src/context/context.service.ts` (`ContextCoreModule`, both API and MCP)          |
| REST route                  | `apps/api/src/context/context.controller.ts` (`ContextModule`, API only)                   |
| MCP tool                    | `apps/api/src/mcp/tools/search.ts`                                                         |
| Project-bank recall         | `MemoryRuntimeService.recallProjects` in `apps/api/src/memory/memory-runtime.service.ts`   |
| Contracts                   | `ContextRequest` / `ContextResponse`, `CONTEXT_*` in `packages/contracts/src/documents`; `AnalyticsContextResponse` in `.../analytics` |
| Rollup                      | `AnalyticsQueryService.context`                                                            |
| Hook                        | `apps/api/src/mcp/capture-kit.ts` (`ticket`, `ticket-prompt`)                              |
| Skill step                  | `renderTicketStep` in `apps/api/src/mcp/skill-sections.ts`                                 |
| Web                         | `AnalyticsPage.vue` (Agents tab), `ConnectAiPage.vue` (step 4)                             |
| Tests                       | `test/context.spec.ts`, `test/analytics-context.e2e-spec.ts`, `src/mcp/capture-kit.spec.ts`, `test/mcp-http.spec.ts` |

## Not built

- A hook that holds a key and calls the API itself — decided against: the kit's trust model is that a hook calls
  nothing.
- Summarising the context with a model (`reflect`, mental models).
- Per-repo configuration (`.knowledge/context.yml`) — add when a team asks.
- Personal memory banks in the answer.
- Hooks for clients with no context-injection hook (Codex, Kimi): the skill step covers them.
- Tuning the budget or floors from the numbers automatically; `make tune` can read them later.
