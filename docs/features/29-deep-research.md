# 29 — Deep research

Feature 25 gave the assistant `web_search` and `web_fetch`. A tool call answers
_what is the current status of X_ in one round trip and leaves nothing behind.
It cannot answer _compare how three vendors handle Y_, because that is not one
retrieval — it is a dozen, each chosen in light of what the last one returned,
plus a judgement about when enough is enough.

The gap is the loop, not the tools. Feature 25 said as much in its own opening:
"the Perplexity shape is already built and running against internal sources.
This feature adds two tools and a trust model, not an architecture." This one
adds the architecture.

It also closes feature 25's last open sentence. The `researcher` was left
`surfaces: ['interactive']` with no executor, because "a background researcher
whose output cannot become a document produces citations to nowhere," and the
declaration was to widen "in the cut that ships promotion and the executor
together — one change, with something to run." This is that cut.

## Where it runs: a background agent, not a workflow

Feature 17's workflow engine looks like the obvious host — it already has
`ai.generate` fan-out, a definition graph, and a run table. It is the wrong
host, for three structural reasons, none of which is a missing feature:

1. **Fan-out children are a review queue, not a parallel executor.**
   `WorkflowRunnerService.fanOut` writes `status: 'awaiting-review'` as a
   literal, not from `step.autoApprove`, and the processor deliberately does not
   open `step.next`. Decompose → run N sub-queries cannot proceed unattended: a
   person must approve all N first. That is correct for the feature it was built
   for and fatal here.
2. **There is no join.** `gather()` hands a node the run's root document and its
   own parent draft — no node can read its siblings, deliberately. Synthesis is
   precisely the operation the engine has no representation for.
3. **No loops.** `findCycle` rejects cyclic graphs, so "the answer is thin,
   search again" is inexpressible.

A fifth `RUNNABLE_AGENTS` case is the right home. It already has what a long run
needs: a durable row, owner rehydration into a real `Principal`, a budget
re-check at execution, and a poll endpoint. What it lacks is listed under
_Prerequisites_ below, and all of it is smaller than the three items above.

## Stopping is the design

Every deep-research system is search → read → reason → decide-what-next. What
separates them is what makes them stop, and the surveyed implementations fall
into four families:

- fixed depth/breadth recursion (predictable cost, no notion of sufficiency);
- a step-capped tool loop (the SDK loop with a ceiling);
- model-declares-done with a hard ceiling;
- **budget + evaluator + a last-resort pass.**

Only the fourth asks _is the answer good enough yet_ rather than _have I done
enough work_. Jina's `node-DeepResearch` is the only open implementation of it,
and its shape is what this feature copies:

- One loop bounded by a **token budget**, with a fixed slice — Jina reserves
  15% of 1M — held back for the endgame.
- **Generation and evaluation are separate prompts.** Criteria are derived from
  the question first, then checked individually; the answer passes only if every
  criterion passes.
- On failure, an error analysis is written into the knowledge base, the diary is
  wiped, and the step counter resets — the agent restarts carrying what it
  learned rather than looping on the same failure.
- **A guaranteed floor.** Budget exhausted with no answer: disable every action,
  narrow the schema to answer-only, run once more, and ship that. Something
  beats nothing, and a run that can end in silence will.

The budget is the honest unit here because it is the one the platform already
meters. `ai_usage` records every call; `assertWithinBudget` already refuses a
run whose workspace is out of quota. A research loop bounded by rounds would be
bounded by a number nobody can price; bounded by tokens it is bounded by the
same number the Usage tab shows.

## A flat queue, not recursion

The tempting structure is a tree: the question spawns sub-questions, each of
which spawns its own. Jina tried it and rejected it, and the reasoning applies
here unchanged — budget forcing is intractable when sub-questions recurse, and
the context-isolation benefit is marginal.

What replaces it is a rotating FIFO over one shared context: a reflection step's
gap questions go to the **front** of the queue, the original question is
appended to the **back**. An answered gap immediately benefits every question
after it, and the budget is spent against one flat list whose length is visible.

This matters more than it looks, because it is also what makes the run
reportable. A queue has a length; a tree has a frontier. `stage` and `progress`
on the run row can say "4 of 11 questions" from a queue and cannot say anything
honest from a tree.

## Citations are assigned, not written

The strongest empirical finding in the research is also the least comfortable:
across deployed systems, **citation accuracy ranges 40–80%**. More than 94% of
citations resolve to a working, topically relevant page, while fact-check scores
range 24–77%. A working link to a relevant page is not evidence, and any design
that trusts the writer to cite inline is shipping a number in that band.

Three mitigations, in the order they pay:

**Labels are assigned server-side, before the model sees the results.** Each
search gets a contiguous block of citation numbers; the prompt asks the model
only to _place_ markers, never to choose them. Numbering cannot drift because
the model never holds the counter. This removes an entire class of failure
structurally rather than probabilistically, which is the same reason
`GraphService` owns the workspace predicate instead of asking each caller to
remember it.

**Best-of-N against a grounding metric.** Sampling four candidate answers and
keeping the one scoring highest on automatic citation recall buys +11.2 points
of citation recall on one benchmark and +18.2 on another, with human evaluation
confirming the gain is real rather than an artifact of the metric. It is a
remarkably high yield for its simplicity, and it costs exactly N× one
generation — a number the budget above can hold.

**The anchoring primitive already exists.** `apps/web/src/lib/anchor-match.ts`
(feature 15) normalizes, finds all occurrences, scores by surviving
prefix/suffix, and reports _outdated_ rather than silently re-anchoring — the
W3C TextQuoteSelector shape. A web citation that carries a quote can be verified
against the fetched text with the code that already verifies a comment against
a page. Nothing new is needed to make a citation checkable; it needs to carry
the quote.

## Parallel reads, serial writes

`assistant.client.ts` executes tool calls in a plain `for … of` with `await`
inside, in both the buffered and streaming harnesses. Ten parallel `tool_calls`
in one round are ten sequential fetches, and at `WEB_TIMEOUT_MS` of 15s that is
150 seconds of wall clock for work the model asked to do at once. Every BullMQ
queue also runs at the default concurrency of 1, so there is no parallelism at
the job layer either.

The fix is not simply `Promise.all` over the requested calls. The streaming loop
checks `signal?.aborted` **between** calls on purpose: "tools can create pages
and open merge requests, so 'stop' has to mean stop _before_ one of those runs."
A batch in flight cannot be interrupted between its members, so the naive change
quietly downgrades Stop from _no further side effects_ to _no further output_.

So the partition is by effect, and the list already exists:
`ASSISTANT_WRITE_TOOL_NAMES` is exactly `create_document | propose_update |
edit_relations`. **Reads run concurrently; writes stay serial and keep the
abort check between them.** The budget is not an obstacle either — `spent++`
increments as it iterates only because execution is serial, and partitioning
`requested` into allowed and overflow up front at `budgetLeft` gives identical
accounting with no ordering dependency.

## A run that outlives the reaper

`AgentScheduleSweeper.requeueStuck` presumes any run still `running` after
`STALE_RUN_MS` (30 minutes) is dead, and `agent.processor.ts` writes the row
exactly twice — the guarded claim, then the terminal result. Nothing in between,
so `updatedAt` is frozen at claim time for the whole run.

Two consequences, and the second is worse than the first:

- Any run over 30 minutes is re-queued, up to `AGENT_MAX_ATTEMPTS` (3),
  duplicating its model spend.
- `requeueStuck` sets the row back to `'pending'`, which is exactly the state
  the retry's guarded claim looks for — so a **second execution starts while the
  first is still running**, and the terminal write is a plain `update`, not a
  guarded `updateMany`, so both complete and the last writer wins. The
  back-pressure check in `startDue` does not cover this path; it only guards
  scheduling a new run.

This is latent today because the three existing background agents finish well
inside the window. It becomes live the moment a research agent exists, since
deep research runs five to thirty minutes _by design_. The heartbeat is
therefore a prerequisite of this feature and not a refinement of it: the run row
gains `stage`/`progress`/`warnings` — converging on `connector_runs`, which is
already the fullest polling vocabulary in the schema — and the executor writes
them as it goes, which fixes the reaper and the blank progress bar with one
change.

## Fetching: the ladder stops short of a browser

"Use a stealth browser" is the intuitive answer to being blocked and it is
mostly wrong, for two independent reasons.

**The first is that it does not buy what it appears to.** What decides a block
in 2026 is cross-layer coherence — TLS/JA4 against the claimed browser version,
JA4H header order and casing, HTTP/2 SETTINGS — and then how the browser is
driven, not what the page advertises. In the best public benchmark of the year,
an HTTP-only client with correct TLS impersonation at **58 MB** scored _better_
than patched Chromium forks, one of which peaked at **13.3 GB**. (Single IP, 31
targets, one night; the author states rankings invert under proxy rotation.
Directionally strong, not a guarantee.)

**The second is that it is the only rung that breaks a guarantee we already
have.** `safeFetch` closes SSRF inside the connection's own resolution — undici
gets a `lookup` that refuses private addresses, so the address checked is the
address dialled and there is no TOCTOU gap. A headless browser resolves DNS in
its own network stack. There is no hook. Containing one means an
egress-filtered network namespace, `--proxy-server` with an **emptied**
`--proxy-bypass-list` (Chrome bypasses private ranges by default — that default
is the hole), and firewall rules; `--host-resolver-rules` is a convenience, not
a boundary.

Ranked by that property the usual instinct inverts:

| rung                          | SSRF guarantee                                           |
| ----------------------------- | -------------------------------------------------------- |
| `safeFetch`                   | full; weakest fetching                                   |
| TLS-impersonating HTTP client | own resolver — needs an egress proxy to restore it       |
| **local headless browser**    | **structurally incompatible; no hook exists**            |
| self-hosted service           | guard does not apply, but it is already a separate netns |
| commercial unblocker          | full, _by remoteness_ — vendor IPs cannot reach RFC1918  |

The guarantee is inversely correlated with local capability, and the local
browser is the only rung that costs it. So the ladder is: revalidate from cache
→ `safeFetch` with real extraction → a TLS-impersonating client when that bites
→ a vendor for the genuinely hard targets → **fail, and say so**. The
browser rung is skipped rather than deferred; it is added only if a target
appears that a vendor cannot serve, and it arrives with its containment or not
at all.

Two rules cut across every rung. **Each one is a new fetch site and must
re-apply the source policy** — feature 25 enforces at the fetch in both
directions with no provenance exception, and every rung is a new place to drop
that. And **untrusted-content wrapping must survive the whole ladder**: while
researching this, a vendor's own pricing page was found carrying an embedded
instruction addressed to AI agents, telling them to fetch external onboarding
URLs. It was ignored. It is a live demonstration that fetched bytes are hostile
input regardless of how reputable the host looks.

## Extraction is the first cut

Before any of the above, the cheapest fidelity win is the extraction step, and
it is cheap because it needs no loop, no schema change and no new rung.

`htmlToMarkdown` is Turndown with a **fixed tag denylist**. That is not
extraction, it is tag stripping: anything boilerplate not inside one of those
tags — sidebars, related-article rails, comment sections, cookie-notice
remnants — survives into the model's context. On the standard benchmark, raw
HTML scores 0.667 F1 against roughly 0.92 for a real content-scoring extractor.
Feature 25 chose Turndown for a good reason ("writing a second extraction step
would mean maintaining two answers to what part of this page is the article"),
and that reason still holds — which is why this adds a scoring pass in front of
the existing serializer rather than a second serializer beside it.

Four changes:

- **A content-scoring pass** before Turndown, so the markdown is made from the
  article rather than from the page.
- **PDFs are no longer refused.** The content-type gate admits only
  html/plain/xhtml, so a link to a PDF — the format research questions land on
  most — fails outright, despite `unpdf` already being a dependency for
  feature 16.
- **Fallbacks trigger on empty-or-short output, never on HTTP status.** A
  client-rendered page returns 200 with an empty shell; some anti-bot walls
  return nonstandard codes. Status is the wrong signal in both directions.
- **A thin extraction is reported, not hidden.** When a page yields
  suspiciously little, the tool result says so. The model treating "extraction
  failed" as "the page says nothing" is the failure mode that produces a
  confident answer from an empty div.

## What this cut deliberately leaves out

**Promotion**, still. Feature 25 deferred turning a cited page into a document
with a `SOURCED_FROM` relation, and the reasoning that it is "where all the
graph and provenance design work is" has not changed. What changes is that a
finding can now _carry_ its web sources, so the existing
`findings/:index/propose` path — drafter over the cited material, merge request
attributed to the caller — is the minimal version of promotion, and the graph
half can land against a behaviour that exists rather than a guess.

**Reranking and entailment checking.** A CPU cross-encoder in front of the
context, and a small entailment model gating each claim, are both well-evidenced
and both belong after there is a loop to measure. Adding them now would tune a
pipeline whose shape is not yet fixed.

**Parallel job execution.** Reads parallelize inside a turn; the queues stay at
concurrency 1. One research run at a time per workspace is already the rule
(`startDue`'s back-pressure), and raising queue concurrency is a change whose
blast radius is every processor, not just this one.

**A keyed search backend.** SearXNG stays primary, because it returns URLs and
snippets and fetches nothing, which is the ordering that lets the policy be
enforced before retrieval. Its fragility is real — upstream engines suspend it
for an hour after a 429 and a full day after a CAPTCHA, and no `settings.yml`
change lifts that — but feature 25 already recorded the answer: `web_search` is
one function with one caller, and the keyed backend is added where the
reliability actually bit.

## Prerequisites

Ordered, because two of them are bugs rather than features and the loop cannot
be trusted on top of either.

**Status is recorded in [`29-deep-research-todo.md`](29-deep-research-todo.md),
not here.** This section is the plan as first written; that file records what is
true in the tree, carries the file:line evidence for each item, and is the newer
of the two wherever they disagree. Read it first.

1. ~~Extraction~~ — **shipped in v0.5.0** (#18). `web_fetch` scores a page for
   its article before serializing it, reads PDFs, and reports a thin or failed
   extraction rather than serving a near-empty page in silence.
2. `stage`/`progress`/`warnings` on `agent_runs`, written as the run proceeds,
   and a guarded terminal write. Fixes the reaper race and the blank poll.
3. Parallel read tools with serial writes, per the partition above.
4. `WebResearchService` made worker-loadable. `AgentWorkerModule` excludes
   `AssistantToolsService`, which is what pulls it in; the service itself needs
   only `ConfigService` and `SourcePolicyService`, so this is a module split of
   the kind `AiCoreModule` and `GlossaryCoreModule` already established.
5. `AgentFinding` widened to carry web sources. Today `readFinding` drops any
   finding not citing a workspace document id, so a research finding would be
   silently discarded. `AssistantWebSource` already exists and already works in
   the chat path; it is not wired into findings.
