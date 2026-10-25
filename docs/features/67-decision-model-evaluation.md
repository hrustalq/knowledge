# 67 — Decision model evaluation: TypeSafe Jev

Issue [#477](https://github.com/hrustalq/knowledge/issues/477). This began as
research only, and the adopted verdicts shipped in #530
([What shipped](#what-shipped-530)). It records which of our model calls a
hosted decision model could take over, measured on our own data rather than
taken from the vendor's claims.

Several of our model calls are not generation. They are narrow decisions: pick
one of N, yes/no, or a level on a rubric. Each one goes through a chat LLM with
`json: true`, its free-form JSON is parsed with `safeJson`, and the call site
trusts a `confidence` the model wrote about itself.
[TypeSafe's Jev](https://typesafe.ai/) answers typed questions instead:

- `choice`: one option of a fixed set, with a probability per option;
- `score`: a level of an ordered rubric, with a probability per level;
- `noul`: the probability that a statement is true.

Every question in a request is answered in parallel against one shared `state`.

## Verdicts

| Call site | `AiUsageOperation` | Verdict | Why, in one line |
| --- | --- | --- | --- |
| Temporal arbiter, `agent.executor.ts` `arbitrate` (#81) | `contradiction` | **Adopt as pre-filter** | At p ≥ 0.2, `jev-1-13` passes 11 of 40 real pairs to the LLM and keeps all 20 contradictions. That lifts the 20-pairs-per-run cap for about 43% less per pair |
| Citation support, after `finalizeCitations` | — (new) | **Adopt** as an added check | 100% on 40 ru+en items. At 0.011 ₽ per sentence it is cheap enough to run on every cited sentence. Nothing checks support today |
| Harvester, `harvest.service.ts` (#82) | `harvest` | **Adopt as pre-filter, low priority** | 100% (en) and 95–100% (ru) vs gpt-6-luna's 90–95%. But a person asks for every harvest today, so most threads do settle something and the saving is small |
| Router tiebreak, `agent-tiebreak.service.ts` | `route` | **Reject for now** | All three systems were 100%. Prod has never routed a request, so a switch buys nothing measurable. It works as a drop-in later, about 2.5× cheaper |
| Quality auditor, `agent.executor.ts` (#74) | `audit` | **Reject** | Mixed: completeness level 50% vs gpt-6-luna's 72% on Latin-heavy pages, better on 10 ru pages. The issue messages still need the LLM, so Jev would be an extra call, not a replacement |
| Re-ranking `ranking.ts`'s top-20 | — (new) | **Reject for now** | No gain on ru (MRR 0.73 → 0.72). A small gain on Latin-heavy pages (0.28 → 0.39, n = 15) costs 2.5–3.7 s and 0.24 ₽ per query |

The adopted call sites were built in
[#530](https://github.com/hrustalq/knowledge/issues/530); see
[What shipped](#what-shipped-530).

## What was measured, and how

**No labelled history existed.** The plan was to reuse prod's routed requests,
`knowledge_conflicts` and `document_quality_scores` as labels. On 2026-10-25,
prod had none:

| Table | Rows |
| --- | --- |
| `ai_usage` | `chat-stream` 36, `suggest` 8; nothing else |
| `agent_runs` | 0 |
| `knowledge_conflicts` | 0 |
| `document_quality_scores` | 0 |
| harvest captures | 0 |

No provider profiles are configured. The one workspace with a corpus, RTech OMS
(325 pages, 3,039 live chunks over 120 characters), runs on an inline gen-api
config with `gpt-6-luna`. That model is therefore the baseline: it is what every
call site would resolve to through `resolveFor`.

**Items, 20 per language per call site** where the corpus allowed:

| Call site | Real items | Synthetic items |
| --- | --- | --- |
| Arbiter | 40 closest page pairs from `candidatePairs`, all above the 0.82 floor | 40: a real passage against a judge-written passage from "another page" that contradicts it (20) or agrees with it (20) |
| Auditor | 40 pages | — |
| Router | — | 42 requests grounded in the corpus's page titles, 6 per candidate agent |
| Harvest | — | 40 threads, half settling something |
| Citation | — | 40: a supported and an unsupported sentence per real passage |
| Re-rank | — | 30 questions written against real chunks; candidates are the bge-m3 top-20 over all live chunks |

**Systems compared per item:**

- the reference, `claude-opus-5-5`;
- the baseline, `gpt-6-luna` with the **v0.33.1 prompts**: the built-in
  `instructions`, `auditMessages`, the harvester's user message and
  `wrapUntrusted`, byte-identical to what prod sends;
- `jev-1-13` (served as `jev-1.13-20260917`) and `jev-latest` (served as
  `jev-1.14-20261014`), both through gen-api.

Page text in Jev's `state` is wrapped with `wrapUntrusted` too.

**The reference.** For real items it is the judge's answer under the same
prompt. For synthetic items it is the intent the item was written with. The
judge's agreement with that intent is reported separately (`judge-vs-intent`).
The gen-api balance ran out before the judge reached 34 arbiter and 22 audit
items. For the arbiter, those 34 were 2 real pairs and 32 synthetic ones, and
the synthetic ones carry their intent. The spot-check filled the gap:

- 2 arbiter pairs and 10 Russian audit pages were labelled directly;
- 16 arbiter and 4 audit references were checked, and all 20 were agreed with.

**The spot-check was done by Claude in the authoring session, which is the same
model as the judge.** It catches the judge's slips, but it is not an
independent human reference.

**Language.** The corpus is essentially monolingual Russian. The language split
uses the share of Cyrillic letters, so "en" on a **real** item means a
Latin-heavy Russian page: an API attribute table, code, or frontmatter-heavy
links. Genuine English prose exists only in the synthetic items, which were
written in each language.

**Samples are small:** 10 positives per language per binary call site, 10–20
pages per auditor cell. Read a difference of one or two items as noise.

## Results

### Arbiter

| lang | system | accuracy | precision | recall | ECE | Brier |
| --- | --- | --- | --- | --- | --- | --- |
| en | gpt-6-luna | 92% | 100% | 70% | 0.08 | 0.08 |
| en | jev-1-13 | 92% | 100% | 70% | 0.10 | 0.06 |
| en | jev-latest | 92% | 89% | 80% | 0.06 | 0.05 |
| ru | gpt-6-luna | 98% | 91% | 100% | 0.03 | 0.02 |
| ru | jev-1-13 | 98% | 91% | 100% | 0.11 | 0.03 |
| ru | jev-latest | 95% | 83% | 100% | 0.10 | 0.04 |

Shipped as is (gpt-6-luna plus `readJudgement`'s 0.7 confidence floor and its
quote check), the arbiter scores the same as raw gpt-6-luna on these items.

**The judge found no contradiction among the 40 real pairs**, and the
spot-check agreed. On this corpus the closest pairs are v1/v2 pages of the same
API method and templated attribute tables: near-duplicates that differ without
disagreeing. So a pre-filter's real job is rejecting those cheaply:

| Jev as pre-filter | Real pairs sent to the LLM | Contradictions kept |
| --- | --- | --- |
| `jev-1-13`, p ≥ 0.2 | 11 / 40 | 20 / 20 |
| `jev-1-13`, p ≥ 0.3 | 4 / 40 | 19 / 20 |
| `jev-1-13`, p ≥ 0.5 | 1 / 40 | 17 / 20 |
| `jev-latest`, p ≥ 0.2 | 13 / 40 | 20 / 20 |
| `jev-latest`, p ≥ 0.3 | 8 / 40 | 20 / 20 |

The LLM call stays, because a conflict needs `aQuote` / `bQuote`, which Jev
cannot produce. Those quotes are what `readJudgement` checks against the
passages, and that check is enforced at the point of action.

### Harvest pre-filter

| lang | system | accuracy | precision | recall |
| --- | --- | --- | --- | --- |
| en | gpt-6-luna (captures ≠ []) | 95% | 91% | 100% |
| en | jev-1-13 | 100% | 100% | 100% |
| en | jev-latest | 100% | 100% | 100% |
| ru | gpt-6-luna (captures ≠ []) | 90% | 83% | 100% |
| ru | jev-1-13 | 100% | 100% | 100% |
| ru | jev-latest | 95% | 91% | 100% |

At p ≥ 0.5, `jev-1-13` kept all 20 threads that settle something and passed
none of the 20 that settle nothing. The baseline's misses are proposals from
threads written to settle nothing. The full harvester still runs on every
thread that passes, and `planCaptures` would drop an ungrounded proposal.

### Citation support

All three systems scored 100% in both languages, as did the judge against the
intent. At p ≥ 0.5, both Jev versions kept all 20 supported sentences and
passed none of the 20 unsupported ones. There is no baseline in prod:
`finalizeCitations` strips labels the turn did not hand out and never checks
that a passage supports its sentence.

### Router tiebreak

Every system was 100% on 42 requests (21 en, 21 ru). Jev's p_max for its choice
was 0.96–0.99 throughout, so calibration cannot be read off a sample with no
errors. The candidates are the seven agents on the `interactive` surface, in
registry order, with their en/ru descriptions. The vendor warns that `jev-1.13`
leans toward the first option, and with no errors that bias did not show here.

### Quality auditor

Four levels: below 50, 50–69, 70–89, 90+.

| lang | system | clarity exact | completeness exact | both within one level |
| --- | --- | --- | --- | --- |
| en (Latin-heavy), n = 18 | gpt-6-luna | 56% | 72% | 94–100% |
| en (Latin-heavy), n = 18 | jev-1-13 | 61% | 50% | 83–100% |
| en (Latin-heavy), n = 18 | jev-latest | 61% | 50% | 94–100% |
| ru, n = 10 | gpt-6-luna | 50% | 50% | 100% |
| ru, n = 10 | jev-1-13 | 60% | 70% | 100% |
| ru, n = 10 | jev-latest | 70% | 50% | 100% |

The vendor says `jev-1.13`'s "score levels are weak in numerical calibration",
and the mixed result above is consistent with that. Jev also cannot write the
issues a page's score comes with.

### Re-ranking

| lang | order | hit@1 | hit@5 | MRR@20 |
| --- | --- | --- | --- | --- |
| en (Latin-heavy), 15 queries | bge-m3 cosine | 20% | 40% | 0.28 |
| en (Latin-heavy), 15 queries | jev-1-13 | 13% | 47% | 0.29 |
| en (Latin-heavy), 15 queries | jev-latest | 33% | 47% | 0.39 |
| ru, 15 queries | bge-m3 cosine | 60% | 87% | 0.73 |
| ru, 15 queries | jev-1-13 | 60% | 93% | 0.72 |
| ru, 15 queries | jev-latest | 60% | 87% | 0.72 |

This uses the vendor's cookbook shape: one noul per (query, passage) pair, 20
requests per query in parallel. The gold chunk was in the top-20 for 23 of the
30 queries. The BM25 leg was not part of this measurement.

### Calibration

Jev's `confidence` is **not** a probability of being right. Per
[the vendor's page](https://docs.typesafe.ai/confidence.md), for a choice it is
`(p_max − 1/n) / (1 − 1/n)`, a measure of how spread the answer is; noul
answers have none. The vendor publishes no calibration measurement. Everything
below is therefore read off the probabilities Jev returns (a noul's p, a
choice's p_max, a score level's probability), binned against what was true.

- **The ends are honest.** On the arbiter, harvest and citation checks, every
  item Jev put at p < 0.2 was false, and every item at p ≥ 0.8 was true
  (n = 7–24 per bin).
- **The middle is not.** The 0.4–0.6 and 0.6–0.8 bins held 1–4 items each, and
  were right or wrong at random. For example, the ru arbiter put 4 items at
  0.47, and all 4 were false.
- **ECE 0.06–0.11 for Jev** on the binary call sites. gpt-6-luna's
  self-reported confidence, mapped the same way, was 0.01–0.08 on these
  samples. On this data, Jev's probabilities are not better calibrated than the
  LLM's self-report. Their advantage is that they come typed, for every item,
  with no parse step.

## Latency

From the prod Mac mini to gen-api, 20 sequential calls each with a synthetic
pair (2026-10-25):

| System | p50 | p95 | fastest |
| --- | --- | --- | --- |
| gpt-6-luna (chat, `json_object`) | 2,355 ms | 7,656 ms | 1,925 ms |
| `jev-1-13` through gen-api | 2,537 ms | 7,658 ms | 2,391 ms |
| `jev-latest` through gen-api | 2,565 ms | 7,662 ms | 2,383 ms |

**Through gen-api, Jev is not faster than gpt-6-luna.** Even the fastest call
took 2.4 s, so the time is gen-api's synchronous call overhead, not the model.
The vendor's "70–500 ms" is not reachable on this path. On the laptop run,
`jev-latest` had a much tighter tail than `jev-1-13`, whose p95 reached 8–14 s
on some call sites.

## Cost

These are gen-api list prices, which is the only path we can pay for (see
[Terms and data path](#terms-and-data-path)):

| Model | Input | Output |
| --- | --- | --- |
| `jev` | 0.0105 ₽ per 1k tokens | free |
| `gpt-6-luna` | 0.025 ₽ per 1k tokens | 0.125 ₽ per 1k tokens |

TypeSafe's own price is $0.042 per 1M input tokens, and gen-api's usage
response carried that figure. Per 1k calls, on our inputs:

| Call site | gpt-6-luna | Jev |
| --- | --- | --- |
| Arbiter (a pair) | 44.0 ₽ | 13.1 ₽ |
| Harvest (a thread) | 31.7 ₽ | 6.5 ₽ |
| Citation (a sentence) | 22.7 ₽ | 10.8 ₽ |
| Router | 17.0 ₽ | 6.8 ₽ |
| Auditor (a page) | 175.2 ₽ | 45.6 ₽ |

Jev's ratio is **2.5–4×, not the vendor's "440×"**. The input-price gap is
2.4×, and the rest comes from free output, while Jev's request carries the
criteria as extra input.

At today's volume none of it matters: prod has made **no** decision calls. The
case for Jev is what a cheap typed decision lets us stop rationing (next
section), not a lower bill.

**What this research cost:** about 560 ₽ of logged calls, plus an unlogged
amount for writing the synthetic items. 93% of it was the reference judge
(`claude-opus-5-5`, 1 ₽ / 5 ₽ per 1k tokens). A repeat should budget for the
judge first, or cap its `max_tokens`: gen-api reserves the full output budget
before each call, and that is what exhausted the balance mid-run.

## Where Jev's price makes it the right tool

Jev pays off where the decision is **binary or pick-one**, **high-volume**, and
**rationed today by the cost of an LLM call**. In those places a cheap typed
answer either removes a cap or replaces a guessed threshold. The cost
arithmetic below uses the per-call prices above. "Measured" means this
evaluation measured it; the rest is a candidate for its own measurement.

**Measured:**

- **Arbiter coverage.** RTech OMS has **3,967** page pairs above the 0.82
  floor. `CONTRADICTION_MAX_PAIRS_PER_RUN = 20` means a first full sweep takes
  about 200 runs.
  - All of them through gpt-6-luna: 3,967 × 0.044 ₽ ≈ **175 ₽**.
  - Jev on all, then gpt-6-luna on the 28% that pass at p ≥ 0.2:
    3,967 × (0.0131 + 0.28 × 0.044) ≈ **100 ₽**, with no contradiction lost in
    the sample.
  - At p ≥ 0.3: ≈ **70 ₽**, with one of 20 lost.
  - Either way the cap can rise from 20 to the whole set.
- **Citation support on every answer.** At about 5 cited sentences, an answer
  costs 0.054 ₽ in Jev calls. That is cheap enough to check every answer, and
  an LLM version would cost twice that.
- **Harvest "nothing to keep".** A thread that settles nothing costs 6.5 ₽ per
  1k instead of 31.7 ₽, and gets a typed "nothing to keep" before the
  harvester call. The saving scales with the share of empty threads, which is
  low while every harvest is asked for by a person.

**Not measured; candidates for the follow-up:**

| Where | Today | Jev's role |
| --- | --- | --- |
| Capture dedupe (#73, #234) | `CAPTURE_DEDUPE_THRESHOLD = 0.92` / `CAPTURE_AMEND_THRESHOLD = 0.8` decide on raw cosine, and #234 found the band hard to calibrate on bge-m3 | A noul "does B restate A?" only inside the 0.80–0.92 band, where cosine cannot decide |
| Entity aliases | `EntityAlias` rows are made by hand | A noul "same entity?" over fold-near keys such as `сервис:биллинг` / `service:billing`, proposing aliases for review (vendor cookbook "Knowledge graph entity alignment") |
| PR drift sentinel ([35](35-pr-drift-check.md)) | The sentinel judges each page tied to a PR with an LLM call | A noul per (page, diff excerpt) first, so the sentinel judges only pages the diff plausibly touches |
| Public Ask and the assistant | The generation call runs even when retrieval found nothing that answers | A noul "do these passages answer the question?" before generation, giving a fast "not in the docs" instead of a paid answer |
| Tester fixture ranking (`test-fixture-ranking`) | An LLM ranks candidate fixtures | A `choice` over the candidates |

**Where Jev is the wrong tool:** anything that must quote, explain or write
(arbiter quotes, audit issues, harvest proposals); numeric scores (the vendor's
own warning); and anything on a latency budget under about 2.5 s, as long as
the path is gen-api.

**Batching** many questions into one request is how Jev is meant to be used,
and it would cut calls and wall time about K×. It was not measured here.
`batch.mjs` (8 pairs per request) was ready, but the balance was spent first.
The vendor warns that accuracy falls as the `state` fills with unrelated
material, so measure it before relying on it.

## Terms and data path

All read 2026-10-25.

**The path is three parties, not one.** Prod would call gen-api
(ООО «Инфимум», Russia), which forwards to TypeSafe in the US. Responses carry
`"provider": "TypeSafe"` and `gen-dec-…` ids, which suggests an intermediate
gateway.

**TypeSafe:**
- **Training:** "We will not train or fine tune any artificial intelligence or
  machine learning models on your prompts or other Input"
  ([Privacy Policy](https://typesafe.ai/legal/privacy-policy);
  [MCA](https://typesafe.ai/legal/mca) §4.1).
- **Telemetry:** may be used "without restriction, including to improve the
  Services" (MCA §4.3).
- **Location:** "The Services are hosted in the United States".
- **Retention:** no period stated. The DPA keeps data "for as long as
  necessary" ([DPA](https://typesafe.ai/legal/data-processing), Schedule I §8),
  and MCA §10.3 says TypeSafe is under "no obligation to store or retain".
  Zero data retention is offered to enterprise customers only.
- **Sanctions:** MCA §16.12 requires the customer not to be located in a
  US-embargoed country. Russia is not named.

**gen-api:**
- **It keeps what we send.** Our probe request's full `parameters` (page text
  included) and its answers were retrievable by id through
  `GET /api/v1/request/get/{id}` an hour after the call.
- **Its policy** (privacy policy, revision of 20.07.2026) lists only generation
  metadata (id, model, type, price, date, status), kept "for the term of the
  contract". It says nothing about request content or the onward transfer to
  the US.
- Whether gen-api's chat proxy, which prod already uses, keeps content the same
  way was not checked.

**Limits:**
- **Size:** body at most 32 MiB; nesting at most 64 levels.
- **Context:** 64k tokens per request and 32k per question; 262k with the
  `TypeSafe-Danger-Zone-Long-Context` header, which gen-api does not expose.
- **Rate limits:** none published by either party. TypeSafe answers 429 / 529,
  to be retried with backoff. We saw neither at 12 concurrent requests.
- **gen-api deviation:** `state` must be an object or array, while TypeSafe
  also accepts a string.

**Versions:**
- `jev-latest` moved to `jev-1.14` on 2026-10-14, and the alias "moves when a
  new release ships, so its answers can change without any change to your
  code" ([models](https://docs.typesafe.ai/models.md)).
- gen-api pins only `jev-1-13`; 1.14 is reachable only through the alias.
- A threshold tuned on `jev-latest` can shift on the next release. Pin, and
  record the `model` each response names.

**Reachability from prod (2026-10-25, 19:21 UTC):**

| From | `api.typesafe.ai/openapi.json` | gen-api |
| --- | --- | --- |
| Mac mini host | `200 0.76 s` | `proxy.gen-api.ru/v1/models` `200 1.06 s`; `api.gen-api.ru/` `404 0.87 s` (the server answered) |
| Inside `knowledge-api-1` | `200`, 594 ms | `api.gen-api.ru/` `404`, 417 ms (the server answered) |

`api.telegram.org` is unreachable from the same box, so this is worth having on
record.

## What shipped (#530)

The adopted verdicts were built in [#530](https://github.com/hrustalq/knowledge/issues/530).
The design follows the sketch this section used to hold.

**A route, not a provider kind.**
- Jev does not speak the chat protocol, so it is not an `AiProviderKind`
  behind `AssistantClient`. It is `DecisionClient`, in the controller-free
  `DecisionClientModule`, which the worker (arbiter) and the API (harvest,
  citations) both import.
- A workspace routes a **GenAPI profile** to the `decision` purpose in AI
  settings → Providers → Decisions; any other kind is refused with a 400.
- Unlike chat, review and extraction, an unrouted decision is **off**: it
  never falls back to the inline config, which is the chat model.
- `DECISION_PROVIDER` (`none` | `gen-api`, default `none`) is the ceiling. At
  `none`, a saved route stays visible and the row says it is not applied.

**One question per call.**
- `DecisionClient.noul` sends one noul to gen-api's `jev` network,
  `is_sync: true`, with `state` an object.
- 429 and 529 are retried twice with backoff. 401, 402 and 403 raise
  `ProviderAccountError`, which stops a pass.
- Batching several questions into one request stays unmeasured, so it is not
  used.

**Pinned model and thresholds.**
- A profile whose model is not a Jev release asks `jev-1-13`
  (`DECISION_DEFAULT_MODEL`) with the profile's key, and drops the prices the
  admin set for its chat model.
- The thresholds are sparse `ai_settings.decision_*_threshold` overrides of
  `DECISION_THRESHOLDS`: arbiter 0.2, citation 0.5, harvest 0.5, all measured
  above on `jev-1-13`.
- Saving an override records the routed model in `decision_tuned_model`, and
  the settings row shows "tuned on" that model.

**Usage.**
- Each question is one `ai_usage` row under the call site's operation:
  `contradiction`, `harvest`, or the new `citation_check`.
- The row carries the model the response names (`jev-1.13-…`) and gen-api's
  own cost.
- The harvest rate limit skips these rows.

**Content and access.**
- Page and chat text in `state` is `wrapUntrusted`.
- The arbiter resolves PG visibility over every candidate before a passage
  leaves.
- Harvest sends only the masked thread.
- The citation check sends only text the turn already handed out.

**What did not change.** A Jev answer filters or marks; it never writes:
- the arbiter still needs the judge's quotes ([57](57-temporal-graph.md));
- harvest still runs the harvester and `planCaptures` on every thread that
  passes ([59](59-chat-harvest.md));
- a citation is marked, never stripped or rewritten ([38](38-answer-provenance.md)).

**Latency.** The citation check runs after a pane answer is shown and is
written back to the message. `/ask` and site Ask are one-shot, so there it
adds one gen-api round trip (about 2.5 s) to the response.

## Reproducing

The spike was scratch code and is not merged. It needs a funded gen-api key and
a corpus dump, and its results are frozen above. It had five parts:

1. a read-only dump script piped into `knowledge-api-1`: pages from PG,
   `source.md` heads from MinIO, live chunks with their bge-m3 vectors from
   ArcadeDB;
2. an item builder that re-implements `candidatePairs`;
3. a runner that calls the judge, gpt-6-luna and both Jev versions with the
   v0.33.1 prompts;
4. a report;
5. a spot-check page.

To repeat it, rebuild from this description, and budget for the judge first.
