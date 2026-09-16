# 29 — Deep research: remaining work

Backlog for the deep research feature (see [`29-deep-research.md`](29-deep-research.md)
for the design and the reasoning behind it). Prerequisites 1–5 have shipped; the
research loop itself and the fetch-revalidation item are open and recorded below,
each with the evidence a fresh reader would otherwise have to re-derive.

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

**2. The heartbeat and the reaper race — was A.**

`agent_runs` gained `stage` / `progress` / `warnings`
(`20260916103000_agent_run_progress`, all nullable, so the previous release's
image can run it). The processor builds an `AgentReporter` and hands it to
`AgentExecutor.run`, which now reports as it works — per page in the reviewer
and glossarist loops, and either side of the single long model call in the
curator and cartographer.

Three things worth knowing:

- **The fix for the race is the guarded terminal write, not the heartbeat.** The
  heartbeat makes reaping rare; it cannot make it impossible, because a single
  model call can outlast `STALE_RUN_MS` on its own. Both terminal writes are now
  `updateMany({ where: { id, status: 'running' } })` and check `count === 1`, so
  a superseded execution discards its own result instead of winning by finishing
  second. Its event is not published either.
- **Every progress write is guarded the same way**, so once the sweeper has
  handed the row to a retry the dead execution stops leaving marks on it. The
  claim resets `stage`/`progress`/`warnings`, or a retry would inherit the dead
  run's position and claim to be somewhere it is not.
- **`stage` is free text, not an enum.** The stages a curator passes through are
  not the ones a research loop will, and freezing them in contracts would mean
  widening a union every time an executor learns a step. The web resolves it
  through `labelFor`, which falls back to the raw value — the
  `documents.category` rule. Unknown stages render as themselves, never as a
  message key.

**3. Parallel reads, serial writes — was B.**

`assistant.client.ts` decides the budget for a round up front, in request order,
then runs the parallel-safe calls with `Promise.all` and everything else one at a
time. Both harnesses, buffered and streaming.

- **The partition is `PARALLEL_SAFE_TOOLS`, an allowlist, not the complement of
  `ASSISTANT_WRITE_TOOL_NAMES`** as this file originally proposed. `READ_TOOL_NAMES`
  ∪ `WEB_TOOLS` and nothing else: an `mcp__<slug>__<tool>` call is an external
  server's code whose side effects this process cannot see, and "not a declared
  write" would have batched somebody else's mutation.
- **The abort check stays exactly where the side effects are** — before each
  serial call. A batch in flight cannot be interrupted between its members, which
  is why the batch contains only calls that change nothing.
- **Results are replayed in the order the model asked**, whatever order they
  finished in, because that transcript is what the next round reads.
- Budget accounting is unchanged by construction: the pre-pass increments the
  same counter in the same order the serial loop did.

**Verified by runtime script** against `apps/api/dist` (the item-1 convention), a
fake OpenAI-compatible server driving both harnesses: three reads and a write in
one round overlap only among the reads, four 300 ms tools complete in 602 ms
rather than ~1200 ms, the trace replays in request order, a budget of 2 runs
exactly two billable calls while a free tool still passes, and a Stop pressed
during the read batch leaves the write unexecuted.

**4. `WebResearchService` is worker-loadable — was C.**

New `assistant/web-research.module.ts` (imports `AiCoreModule`, provides and
exports the service). `AssistantModule` reaches it through that module instead of
providing it directly, so the API path is unchanged.

`AgentWorkerModule` imports it **even though no runnable agent calls the web
yet**, and that is the point rather than dead wiring: Nest instantiates an
imported module's providers at boot, so the worker constructs the service on
every start and fails loudly there if anyone gives it an API-only dependency —
which is exactly how it became unreachable from the worker in the first place.
Confirmed by booting `dist/worker.main.js`: `WebResearchModule dependencies
initialized`, no DI error.

**5. `AgentFinding` carries web sources — was D.**

`AgentFinding.sources?: AssistantWebSource[]`, and `readFinding` now keeps a
finding that cites **either** a workspace page or a fetched URL. Web-only on
purpose: a cited page is already `documentIds`/`documentTitles`, and widening to
`AssistantSource` would give one finding two ways to cite the same page.

- `readWebSources` validates rather than trusts — a URL that does not parse is
  dropped, the scheme must be http(s) (these become `href`s), and the host is
  derived here so a finding cannot claim `docs.stripe.com` while linking
  elsewhere.
- **Behaviour today is unchanged**, deliberately: neither the curator's nor the
  cartographer's output contract asks for `sources`, so no existing agent emits
  any and the grounding rule still drops everything it dropped before.
- `AgentFindingsService.draft` passes the URLs to the drafter as context. It
  passes the *reference*, never a re-fetch: a finding records what a run read,
  and silently re-reading those URLs here would make pressing Propose a second,
  unpoliced trip to the open web.
- The panel renders them with the assistant's own `SourceChip`, so a citation
  reads the same wherever it appears.

**6. `docs/versioning.md#known-drift` corrected — was G.**

The table claimed `0.1.0` and `0.3.0`; both surfaces declare `0.5.0`. The entry
now says what the real defect is — they are correct only because the runbook
bumps them by hand, so they are one forgotten step from lying — rather than
recording two numbers that had since been fixed. The `APP_VERSION` build arg is
still the actual cure and is still not built.

Worth knowing: `make api-client` in this change also corrected **pre-existing**
drift in the committed `apps/api/openapi.json` (`version` 0.2.0 → 0.5.0, and
`maxToolCalls` maximum 16 → 64 from an earlier DTO change that never regenerated
it). Neither came from this work; the generated artifact was simply stale.

---

## Open

### E. ETag / `If-None-Match` revalidation — M

The one Phase A item not built. Rung 0 of the fetch ladder, and the highest-
leverage politeness move available: Cloudflare's own figure is that more than
half of all AI crawl traffic re-fetches pages that have not changed. A 304 also
skips extraction, chunking and embedding, which dominate cost far above transfer.

Needs a cache store (Redis is present) and a TTL tiered by volatility, with an
explicit bypass for recency queries ("latest", "current", "today"). The platform
already has the natural home for the identity half in content hashes.

### F. The research loop itself — L

The feature the design doc is actually about. Shape, argued in
`29-deep-research.md`: a fifth `RUNNABLE_AGENTS` case (not the workflow engine —
its fan-out is a human review queue by construction, it has no join step, and it
rejects cycles), a token budget with a reserved endgame slice, a separate
evaluator prompt, a flat FIFO gap queue rather than recursion, and
server-assigned citation labels.

**Its prerequisites are now met.** A run can report progress without being reaped
mid-flight (2), its reads parallelise (3), the worker can reach the web (4), and
a finding citing only URLs survives instead of being dropped (5). What remains is
the loop.

Two things the prerequisites leave for this item rather than solve:

- **A web-only finding cannot be proposed yet.** `AgentFindingsService.propose`
  still requires `documentIds[0]` — there is no page to rewrite — so such a
  finding renders with its citations and no action. Promotion (a cited page
  becoming a document with a `SOURCED_FROM` relation) is still deferred, per the
  design doc.
- **Nothing emits `sources` yet.** The research agent's output contract is what
  will, and it should say so as explicitly as `OUTPUT_CONTRACT` says "cite a page
  id from the list".
