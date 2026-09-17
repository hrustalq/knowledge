# 31 — Code research

Оригинал: «let's implement code-research tool. we've recently implemented a
github connector that allows us to connect a specific repo — so next milestone
is reverse-documenting codebase, starting with .md files, ending with raw code
files that do some undeclared business logic»

## What this is

Four tools that read a connected repository — `code_tree`, `code_search`,
`code_outline`, `code_read` — offered to the assistant and to agents the way
feature 25 offers `web_search` and `web_fetch`. Ask the chat how pricing works
in a repository the workspace has connected and it can open the file, quote the
lines and cite them; an `author` turn in Agent mode can research a codebase and
write a page about what it found.

And, on top of them, the **archaeologist**: a background agent that
reverse-documents a codebase on its own. It reads what the repository declares
about itself and what the workspace already says, ranks the source by
undeclared business logic, reads the files nothing mentions, and proposes a
page per finding. A person creates the page; a second run treats it as
declared and moves on to what is still undocumented.

The two shipped as two pull requests — the tools first, the agent on top —
and are one feature.

## Why

Feature 27 turns a repository into pages — a hub and one page per module,
derived from tree-sitter facts with one narration each. Feature 30 made
connecting a repository a picker instead of a URL and a token. What neither
gave the platform is a way to *look* at a repository on demand. The archive is
downloaded per sync run, held for the life of that run, and dropped; the
assistant's every tool pointed inward, at pages, and a question whose answer
was in the source could only be answered by a page somebody had already written
about it.

The module pages are a summary. The milestone the platform is heading for —
writing down the business logic no document declares — needs the source itself,
read in the order a person would read it: the README first, then the files it
points at, then the ones it does not.

## Decisions

**Code is a tool here, not a connector unit.** Feature 25's argument, applied
to a repository. A connector makes an external page into a document —
indexed, chunked, diffable, permanent. A tool call is ephemeral and cheap; it
answers one question and leaves nothing behind. Reading a file to settle a
question should not create a page about it, and the derived pages feature 27
does create keep their own shape.

**No new access mode.** The open web needed `WEB_ACCESS_MODE` and a policy
table because whether the model may read a domain is an editorial question
nobody had answered. A connected repository is already inside the tenant
boundary: a workspace admin configured the connector, the credential it holds
was granted for exactly this repository, and the pages the connector derives
are already in the workspace. So the tools are offered whenever the workspace
has at least one enabled `codebase` or `markdown-git` connector, the agent
allowlist intersects on top, and there is no ceiling to clamp. Every execution
re-resolves the connector — workspace, kind, enabled — rather than trusting
whoever decided to offer the tool, because a turn outlives a settings change
(the plugin rule, and the web rule).

**Repository bytes are untrusted data.** The wrapper the web tools use now
lives in `common/untrusted.ts` and takes an origin, not a policy: a file that
says "ignore your instructions" is a file. One implementation, the
`safe-url.ts` reasoning — a second wrapper is a second place for the wording
to drift.

**A code citation is a web source.** `code_read` returns the file's address on
its host — the blob URL, anchored to the lines it returned — as a
`kind: 'web'` source. That is the file's honest identity; it links to GitHub or
GitLab; and `SourceChip`, the sources rail, `assistantSourceKey` and the
findings panel already know how to render a citation that leaves the product.
A third `AssistantSource` kind was drafted and cut: it would have cost every
render site a branch to show what the existing one already shows.

**The snapshot is in memory, per process.** `RepoSnapshotService` holds one
downloaded archive per connector, keyed by connector id, for
`CODE_SNAPSHOT_TTL_MS` and under a process-wide `CODE_SNAPSHOT_MAX_BYTES`
(least recently used is dropped). The promise is cached, not the result — two
tool calls in one parallel batch must not both download — and an edited
connector (`updated_at` moved) reloads on its next open. The API and the worker
each keep their own: the first tool call in either pays one archive download
and the rest are instant, which is the entire cost story. MinIO and Redis were
both considered and rejected — sharing would save one download per process per
TTL at the price of a live repository's contents in a second system with its
own eviction to write.

**Scope follows the connector.** A connector configured with `subdir` documents
that folder; the tools see that folder. The same word means the same thing in
both places.

**One module, both processes.** `CodeResearchModule` is controller-free and
sits beside `WebResearchModule`: `AssistantModule` imports it for the chat
harness, `AgentWorkerModule` imports it so a background agent can read a
repository — and so the worker constructs the services on every boot, failing
loudly the day one gains an API-only dependency.

## What the build settled

**The tool-name sets moved into a leaf.** `assistant.client.ts` imported
`FREE_TOOLS` and `PARALLEL_SAFE_TOOLS` from `assistant.tools.ts`, and the
codebase adapter injects the client — so `registry → adapter → client →
tools` was already a chain. The moment `assistant.tools.ts` injected a service
that reaches back into the connectors layer, that chain was a cycle, and
`make deps` said so. The sets now live in `assistant-tool-types.ts`, which
imports nothing but contracts; `assistant.tools.ts` re-exports them. Lift a
shared helper into a leaf rather than closing a cycle.

**The parser had a race nobody could hit yet.** `TreeSitterService` reuses one
parser with `setLanguage` per file, and split the call across an async helper:
`setLanguage` in one function, `parse` after an `await` in another. Safe while
the only caller was the sync pipeline at BullMQ concurrency 1. The API is not
sequential, and two `code_outline` calls in one round run concurrently — the
second caller's `setLanguage` could land before the first caller's `parse`, and
a TypeScript file would be read with the Python grammar. `setLanguage` and
`parse` are now one synchronous block. `code_outline` joins the parallel-safe
set only because of that.

**`code_search` refuses the pattern shape that hangs.** The query comes from a
model and runs synchronously on the event loop; a catastrophic regex is not a
slow tool call but a stalled process. A group containing a quantifier that is
itself quantified — `(a+)+`, `(\w*)*` — is refused with a reason rather than
timed out, lines over 2 000 characters are not searched at all, and the
pattern is capped at 200 characters.

**`code_read` returns a window, not a file.** 400 lines and 24 000 characters,
numbered, with a note saying where to continue. A file is what the model opened
the tool for; the whole of it is what fills the tool budget in one call.

**A path is normalised before it is looked up.** The snapshot is a `Map`, so
`../../etc/passwd` could never escape anything — but a tool result that reads
that way is a lie about what was read. Relative, never climbing, or refused.

## The archaeologist

Feature 29 argued where a long research loop should live — a `RUNNABLE_AGENTS`
case, not the workflow engine — and why: a durable row, an owner rehydrated
into a real principal, a budget re-check at execution, progress the reaper can
see, and a poll endpoint. This is the fifth case, and the first one that reads
something other than pages.

**Deterministic first, the curator's shape a third time.** Four stages, and
three of them are queries a program answers with no model:

- `snapshot` opens the repository through the same cache the chat tools use.
- `docs` gathers what is *already declared*: the repository's own documents
  (README first, then anything under a docs directory or with a documenting
  name, then the rest — the order matters because the digest is capped, and
  when the cap bites it should bite the file least likely to be an overview),
  plus the workspace pages linked to the connector or under its destination.
  One model call digests that into topics; with no model, the document
  headings stand in and the run says so.
- `candidates` ranks every parseable source file by how much it decides —
  branching constructs per hundred lines, weighted by domain words beside them
  (`validate`, `threshold`, `price`, `permission`, `expire`, `retry`…) and by
  size — after dropping tests, fixtures, config, generated code and hidden
  trees. The top sixty are outlined, and a file is *covered* when the declared
  text mentions its path, its own filename (if specific enough), or two of the
  names it exports. Two, because a single common word appears in prose about
  anything; two exported names together are a page that is about this file.
  The first twelve uncovered files are the candidates.
- `reading` is the judgement: one tool loop per candidate, the file in front
  of the model and the read and code tools beside it to follow an import or
  check a page, returning the page it would write. Progress is the file index;
  a budget refusal ends the run with what it has; a file that fails is a
  warning, not a failure.

**A finding is a page, and it cites lines.** The output contract asks for a
complete page — what it decides, the rules with their exact conditions, where
it lives, what it depends on, open questions — for a reader who will not open
the file. The finding carries that draft, cites paths with line ranges, and
`readExcavation` validates rather than trusts: a path must be in the snapshot
**and** must have been opened during that loop (a path seen in a tree listing
is not a path that was read), the URL is built server-side from the path so a
finding cannot claim the repository while linking elsewhere, and a draft under
two hundred characters is a sentence, not a page, and is dropped.

**Create page is a person acting.** `propose` opens a merge request against
the page a finding cites; these findings cite files, so there is nothing to
rewrite. The sibling endpoint `create-page` publishes the draft as a new page
under the connector's destination — immediately, attributed to whoever
pressed the button, the way `create_document` publishes — with `source:` in
its frontmatter pointing at the first cited file and `generatedBy` naming the
agent, so a reader can tell a page a model drafted from one a person wrote.
The finding then records the page it became, which is what swaps the button
for a link. No model call: the worker generates, the API publishes.

**Re-running converges.** The page lands under the destination the next run
reads as declared, so the file it documents is covered and not proposed twice.
A page that drifts from the code it describes is the curator's problem, not
this agent's.

**The run is scoped to one repository, and the scope is settled at enqueue.**
`StartAgentRunDto.connectorId` names it; the API refuses a connector-scoped
agent without a connector it can resolve, and the web asks for one before
pressing Run — both through `CONNECTOR_SCOPED_AGENT_KEYS`, one predicate, so
the dialog and the 400 cannot disagree. With exactly one repository connected
the choice is implied, which is also how a scheduled run (which carries no
scope) finds its repository. Whatever `connectorId` the model writes into a
tool call, the executor overrides it with the run's — the loop reads one
repository.

## Surface

| tool           | arguments                                                   | returns                                                            |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `code_tree`    | `connectorId`, `path?`, `depth?` (1–4, default 2)            | directories with file counts and sizes, files with size and language; capped at 400 entries |
| `code_search`  | `connectorId`, `query`, `regex?`, `caseSensitive?`, `glob?`, `limit?` (≤50) | matching lines grouped by file, with line numbers          |
| `code_outline` | `connectorId`, `path`                                        | the file's declarations with signatures and exports, and its imports |
| `code_read`    | `connectorId`, `path`, `startLine?`, `endLine?`              | a numbered window of the file; cites the blob URL with a line anchor |

The per-turn system prompt gains a *Connected repositories* list — name, URL,
branch, `connectorId` — when the workspace has any, beside the web clause and
for the same reason: which repositories exist is a per-workspace fact, and a
workspace with none sends byte-identical bytes to what it sent before.

The tools are named in the `researcher` and `author` allowlists and in
`ASSISTANT_CODE_TOOL_NAMES` in contracts, the write-set precedent: one list for
the harness filter, the built-in allowlists and the settings picker.

```
CODE_SNAPSHOT_TTL_MS=600000        # how long a downloaded repository stays fresh
CODE_SNAPSHOT_MAX_BYTES=268435456  # every snapshot in one process, together
```

The agent's surface:

```
POST /v1/ai/agents/archaeologist/run      editor   body { workspaceId, connectorId?, note? }
POST /v1/ai/agents/runs/:id/findings/:index/create-page   editor   → { documentId, title }
```

`AgentFinding.draft` (`{ title, markdown }`) is the new field; `AgentRunSummary`
now carries `input` so the Runs tab can say which repository a run read. Stage
values are `snapshot`, `docs`, `candidates`, `reading`.

## Deliberately deferred

- **A scope column on schedules.** A scheduled run carries only a note, so a
  scheduled archaeologist works in a one-repository workspace and fails, with
  the reason, in any other. `scheduleConnectorId` is the obvious column and
  earns itself when someone schedules one.
- **Batching by module.** One loop per file is the honest unit today; a module
  with six small files that share one rule would be better read together.
- **An evaluator pass.** Feature 29's separate generate-and-evaluate prompts
  would raise the floor on draft quality; they belong after there are drafts
  to measure.
- **MCP tools.** `knowledge_code_*` would serve agent clients that already hold
  the repository they are working in.
- **A `kind: 'code'` source.** The blob URL is the right identity today; a
  dedicated kind earns its render branch when a citation needs to open inside
  the product rather than on the host.
- **A shared snapshot store.** See above; the day two processes downloading
  the same archive is the cost that bites, the identity half already exists in
  content hashes.
- **Cross-repository search.** Every call names one connector. A workspace with
  five repositories asks five times, which is also how the answer says which.

## Verification

`make verify` — lint, typecheck, `make deps` (the cycle above is what it would
have caught) and the spec:

```bash
pnpm --filter @knowledge/api exec vitest run test/code-research.spec.ts
```

covers path normalisation, glob translation, the pattern guard, tree listing
and its cap, line windows, host-specific line anchors, and the snapshot cache —
one download per TTL, a reload when the connector changes, eviction over the
byte cap, and a failed download not served for the rest of the TTL.

End to end, against a workspace with a GitHub connector: ask the chat which
files implement something the repository does. The trail should show
`code_search` then `code_read`, the answer should cite paths and lines, and the
sources rail should carry `github.com` chips linking to the blob at those lines.
Disable the connector and ask again: the next tool call is refused with the
reason, not answered from a stale snapshot.

The agent's own spec is `test/archaeology.spec.ts`: document selection and
order, candidate filtering and ranking, the coverage rule, and everything
`readExcavation` refuses. End to end: run the archaeologist against the same
connector and watch the stages advance; every finding should carry a draft
title and cite `github.com` lines; **Create page** on one should put a page
under the connector's destination with `source:` frontmatter and turn the
button into a link; a second run should not propose that file again.
