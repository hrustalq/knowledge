# 29 — Deep research: remaining work

Backlog for the deep research feature (see [`29-deep-research.md`](29-deep-research.md)
for the design and the reasoning behind it). Prerequisite 1 shipped in **v0.5.0**;
the rest are open and recorded below, each with the evidence a fresh reader would
otherwise have to re-derive.

Effort: S (≤half a day), M (a day or two), L (more).

**Read this before touching the design doc.** The design doc argues; this file
records what is true in the tree today. Where they disagree, this one is newer.

---

## Closed

**1. Extraction — shipped in v0.5.0 (#18).**

`web_fetch` now scores a page for its article before serializing it, reads PDFs,
and reports a thin or failed extraction instead of serving a near-empty page in
silence.

- `extractArticle` in `import/parsers/html-to-markdown.ts` runs Defuddle, then
  the **existing** Turndown. One serializer, a scoring pass in front — not a
  second answer to "how does HTML become our markdown".
- `pdfToMarkdown` in `import/parsers/pdf-text.ts`, called by `web_fetch` and by
  `PdfParser` alike.
- `THIN_ARTICLE_WORDS = 120` in `assistant/web-research.service.ts`.

Four things that are not obvious from the diff:

- **`useAsync: false` on the Defuddle call is load-bearing, not tidiness.** Its
  async extractors fetch from third-party APIs when local extraction is empty —
  an outbound request to a host no source policy authorized, from inside what
  the caller believes is one fetch of one URL. Do not turn it on.
- **`pdf-text.ts` exists because of a dependency rule, not taste.** Depcruise's
  `dip-document-parser-stays-behind-the-registry` forbids anything outside
  `src/import/parsers/` from importing a `*.parser.ts`, so `importFormatFor`
  stays the single answer to which parser handles which format. Importing
  `pdf.parser.ts` from the assistant **will fail CI**. The reconstruction lives
  in `pdf-text.ts` precisely so both callers can reach it.
- **Test the emptiness of text, never of markup.** The first implementation
  guarded on `if (article)`, which a script-rendered shell passes: Defuddle
  returns `<div id="root"></div>`, truthy, scoring zero words. Combined with the
  service's `wordCount > 0` guard that served a near-empty page with _no_
  warning — the exact failure the warning exists to prevent. The guard is now
  `article && (result.wordCount ?? 0) > 0`.
- **`t()` outside a request context returns the key rather than throwing.**
  Verified against a real PDF: `pdfToMarkdown` works with no i18n scope, and its
  `warnings[]` come back as raw keys. `web_fetch` never surfaces `pdf.warnings`,
  so nothing leaks; anything new that does surface them must wrap in
  `withLocale()`.

**How it was verified, since there is no test suite.** Typecheck, lint,
depcruise, build, then a runtime script against `apps/api/dist` covering a
chrome-heavy page, a script-rendered shell, malformed input, and a real 5-page
PDF. The chrome-heavy case is the one worth keeping: the old path retained
`SIDEBARJUNK`, `COOKIEJUNK` and `COMMENTJUNK`, the new path retained none. Any
change here should be re-checked the same way rather than by reading the diff.

---

## Open

### A. `agent_runs` has no heartbeat, and the reaper races — S

**This is a live bug, not a feature gap, and it is a prerequisite rather than a
refinement:** deep research runs five to thirty minutes by design, which is
exactly where it bites.

`agent.processor.ts` writes the row twice — the guarded claim (`:49-52`) and the
terminal result (`:83-91`) — and nothing in between, so `updatedAt` is frozen at
claim time for the whole run. `AgentScheduleSweeper.requeueStuck`
(`agent-schedule.sweeper.ts:69-84`) presumes any run still `running` after
`STALE_RUN_MS` (`:14`, 30 minutes) is dead.

Two consequences, the second worse than the first:

1. A run over 30 minutes is re-queued, up to `AGENT_MAX_ATTEMPTS` (3,
   `agent.constants.ts:8`), duplicating its model spend.
2. `requeueStuck` sets the row back to `'pending'` — **exactly the state the
   retry's guarded claim looks for** — so a second execution starts while the
   first is still running. The terminal write is a plain `update`, not a guarded
   `updateMany`, so both complete and the last writer wins. The back-pressure
   check in `startDue` (`:112-115`) does not cover this path; it only guards
   scheduling a _new_ run.

Fix: add `stage`/`progress`/`warnings` to `agent_runs` and write them as the run
proceeds (converging on `connector_runs`, already the fullest polling vocabulary
in the schema), and make the terminal write guarded. That fixes the reaper, the
race and the blank poll in one change.

### B. Tool calls execute serially — M

`assistant.client.ts:263` (buffered) and `:373` (streaming) are plain `for … of`
loops with `await` inside. There is no `Promise.all` anywhere in the harness, so
ten parallel `tool_calls` in one round are ten sequential fetches — at
`WEB_TIMEOUT_MS` of 15s, 150 seconds of wall clock for work the model asked to
do at once. Every BullMQ queue also runs at the default concurrency of 1.

**Do not simply wrap it in `Promise.all`.** `:386` checks `signal?.aborted`
_between_ calls on purpose — tools create pages and open merge requests, so Stop
means stop before a side effect, not merely stop the output. A batch in flight
cannot be interrupted between its members.

The partition already has a name: `ASSISTANT_WRITE_TOOL_NAMES` in contracts is
exactly `create_document | propose_update | edit_relations`. Run reads
concurrently, keep writes serial with the abort check between them. The budget is
not an obstacle — `spent++` increments as it iterates only because execution is
serial; partition `requested` into allowed and overflow up front at `budgetLeft`
for identical accounting with no ordering dependency.

### C. `WebResearchService` is not worker-loadable — S

`AgentWorkerModule` deliberately excludes `AssistantToolsService`, which is what
pulls `WebResearchService` in, so the worker process cannot construct the web
tools at all and a background researcher currently cannot reach the web.

Cheap: `WebResearchService` takes only `ConfigService` and `SourcePolicyService`.
This is a controller-free module split of the kind `AiCoreModule` and
`GlossaryCoreModule` already established.

### D. `AgentFinding` cannot carry a web source — S

`agent.executor.ts:635-638` (`readFinding`) drops any finding that does not cite
a document id existing in the workspace, so a research finding citing only URLs
is silently discarded. `AssistantWebSource` already exists in contracts and
already works correctly in the chat path — it is simply not wired into findings.

This is what makes a background researcher's output land somewhere, and it is the
minimal version of the promotion the design doc defers: a finding carrying its
sources can go through the existing `findings/:index/propose` path.

### E. ETag / `If-None-Match` revalidation — M

The one Phase A item not built. Rung 0 of the fetch ladder, and the highest-
leverage politeness move available: Cloudflare's own figure is that more than
half of all AI crawl traffic re-fetches pages that have not changed. A 304 also
skips extraction, chunking and embedding, which dominate cost far above transfer.

Needs a cache store (Redis is present) and a TTL tiered by volatility, with an
explicit bypass for recency queries ("latest", "current", "today"). The platform
already has the natural home for the identity half in content hashes.

### F. The research loop itself — L

The feature the design doc is actually about; A–D are its prerequisites. Shape,
argued in `29-deep-research.md`: a fifth `RUNNABLE_AGENTS` case (not the workflow
engine — its fan-out is a human review queue by construction, it has no join
step, and it rejects cycles), a token budget with a reserved endgame slice, a
separate evaluator prompt, a flat FIFO gap queue rather than recursion, and
server-assigned citation labels.

Do not start this before A and B. A loop that cannot report progress will be
reaped mid-run and billed twice, and one that fetches serially will spend its
budget on wall clock.

### G. `docs/versioning.md#known-drift` is itself stale — S

It claims `swagger.ts` declares `0.1.0` and `mcp.service.ts` declares `0.3.0`.
Both were at `0.4.0` before v0.5.0 and are at `0.5.0` now — the table describes a
drift that each release has been fixing by hand. Either correct the table or
build the `APP_VERSION` build arg that document already proposes, which removes
two manual edits from every release.
