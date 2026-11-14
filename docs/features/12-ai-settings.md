# 12 — AI settings

Оригинал: «add ai settings to settings page — we should be able to configure ai,
add skills, add plugins, see token spent per user, logs»

## What this is

A fifth section in `/settings` that makes the assistant layer administrable
from the UI instead of from `.env` and a restart. Five tabs:

| Tab               | What it does                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Configuration** | Providers and the models each serves, routing, temperature, tool budget, timeout, Agent-mode switch, budgets, per-model prices.  |
| **Skills**        | Instruction packs merged into the assistant's system prompt.                                                             |
| **Plugins**       | External MCP servers whose tools join the assistant's tool harness.                                                      |
| **Usage**         | Tokens and estimated cost per user (or per model), a daily chart, and budget administration.                             |
| **Logs**          | One row per upstream LLM call: user, operation, model, tokens, duration, outcome.                                        |

Everything is scoped to the **workspace** — the tenant/ACL boundary — and
managed by workspace admins. The skill roster is the one exception: any member
can read it, because the chat composer offers skills to whoever is typing.

## Why

Before this, `AssistantClient` read `ASSISTANT_*` once in its constructor. A
model change meant editing a file and restarting the API; there was no record
of what the assistant cost or who spent it; and its behaviour was one
hard-coded system prompt with five built-in tools, so a team had no way to
teach it house rules or point it at their own systems.

## Decisions

**A provider is a connection; a model is what it serves (#798).** A workspace can
define named providers (`ai_providers`), "DeepSeek prod" or "Local Ollama": an
endpoint, a credential and a harness budget. Each serves the models in `ai_models`,
identified by the code name its API knows them under. Before #798 one row was both,
so three models from one vendor meant three copies of the key. The migration turned
every profile into one provider and one model **with the same id**, which is why a
workflow step's stored `providerId` still resolves.

**Models are added on purpose.** **Fetch models** calls `GET {baseUrl}/models` through
the SDK and adds only what is ticked, since an aggregator answers with hundreds. Many
OpenAI-compatible servers have no list, so a refusal is an ordinary result: the
upstream message comes back verbatim and the page offers typing a code name. A fetch
never removes a model, and a repeat never duplicates or resets one: `createMany` with
`skipDuplicates` over a `NULLS NOT DISTINCT` unique index.

**Everything pins a model.** Purpose routes (chat and agent turns, background review
and suggestion, the worker's relation extraction, decisions), agents and threads hold
an `ai_models` id. Resolution is `resolveFor(workspaceId, purpose, ...pins)`,
first usable hit wins: thread pin → agent pin → the purpose's route → the inline
default config → the `ASSISTANT_*` env vars. That last step keeps it additive: a
workspace with no models resolves exactly as it did before they existed. A pin that
cannot run is looked past, not fatal: a removed model, another workspace's, or one
whose provider is off.

**Off hides, it does not delete.** A provider's on/off checkbox takes its models out
of every picker (`availableModels`) and out of resolution, and leaves the pins alone,
so turning it back on restores them. A settings select holding a pin at a hidden model
shows that one disabled rather than going blank.

**Members pick from a list an admin curates.** The chat picker (`GET /v1/ai/models/choices`,
viewer, code and provider name only) is every **In chat** model on an enabled provider.
`in_chat` governs members only: an agent or a route may use a model that is off for
chat. It is checked on offer and again on execution (`chatPin`), because a thread
outlives the change.

**One provider list, two tables underneath.** `/settings/ai/config` shows the inline
default config and the named providers as one list (`buildProviderRows`): the default
is the pinned first row, and "Add provider" is the list's last row. The tables stay
separate because their rules differ. The default inherits the environment and is what
every unrouted call falls through to, so it has no name, no off switch but provider
`none`, and no delete. It serves models like any other provider (`ai_models.provider_id`
null), and its own configured model stays implicit, with no row: it answers for "no
route", which is what keeps an empty table equal to the old behaviour. To offer that
model in the chat picker while chat is routed elsewhere, add its code as a model. Each
model row shows the work it actually serves, worked out as the resolver does it (a
route at a model of a provider that is off lands on the default's own model), and a
provider's Test tests that provider, on a model members can use, then any of its models,
then its kind's default. `useDefault` on `POST settings/test` asks for the default config
even while chat is routed elsewhere. A provider's result is stored on its row; the
default's lasts as long as the page.

**A price belongs to a model.** Prices are per 1M tokens in a currency
(`COST_CURRENCIES`), set in a model's dialog, and in the provider's dialog for the
default's implicit model. A model's row is its whole price: it does not inherit the
default config's. `effectiveModelPrice` (contracts) is the one rule: each side
falls back to the list on its own, a model missing a side has no price, and the
list fills a side only in its own currency, since no rate is kept to convert it. A
price stored with no currency means USD, which is what the dialog asked for before
#793. The usage row is written under it and the settings row reads it, so a row
that says "no price" is the row whose calls show `—` in Usage.

**A cached prompt token costs less.** `fromUsage` reads `prompt_cache_hit_tokens`
(DeepSeek) or `prompt_tokens_details.cached_tokens` (OpenAI, GenAPI) and the
estimate charges those at the cached rate. They stay inside `promptTokens` and
`totalTokens`, so budgets count the same tokens as before. The rate comes from the
provider's own field, else the list, and a configured prompt price does not borrow
the list's cached rate. With no cached rate a hit costs the prompt price.

**A cost states its currency.** Each `ai_usage` row holds an amount and
`cost_currency`, and Usage totals per currency (`costs: CostAmount[]`), never one
sum. The column is still `cost_usd_micros` so a release can roll back over it; the
Prisma field is `costMicros`. A GenAPI chat call stores the `usage.cost` it reports,
in rubles, so its row is the real charge rather than an estimate. `usage.cost` from
any other server is ignored because its units are unknown.

**The list has a date.** The comment on `MODEL_LIST_PRICES` says when every row was
compared with its vendor's page, and a model the vendor stops listing comes off. DeepSeek's
page no longer lists `deepseek-chat` or `deepseek-reasoner`, and its prices change
with the hour, so a DeepSeek model sets its own price, which it can do per model.

Deleting a provider takes its models (the one FK here) and clears every route, agent
and thread pinned to them, which is the trade for the pin columns carrying no foreign
key (house style, see `assignee_id`). Cross-tenant ids are rejected at both ends: a pin
is validated on write, and `resolveFor` looks the model up inside the workspace on read.

Routing extraction meant the worker had to resolve providers too, so provider
resolution and token accounting live in a controller-free `AiCoreModule` that
both `AiModule` and `WorkerModule` import — the same split as
`EventsModule` / `EventsApiModule`. `ExtractorFactory` then builds a per-
workspace extractor per job instead of the single env-wired instance.

**Every settings column is an override.** `null` means "inherit the env var",
so an empty `ai_settings` table reproduces the pre-feature behaviour exactly
and the env stays a working deployment path. `AiConfigService.resolve()` folds
DB → env → `PROVIDER_DEFAULTS` and reports, per field, which layer won — that
is what the "from env" badges in the UI are reading.

Relation extraction carries two tuning overrides of its own —
`extraction_min_confidence` and `extraction_max_chunks`, inheriting
`EXTRACTOR_MIN_CONFIDENCE` / `EXTRACTOR_MAX_CHUNKS`. They are workspace-scoped
rather than per profile because they shape extraction *behaviour*, not the
connection, and they travel into `extract()` per call rather than sitting on the
extractor: `ExtractorFactory` caches instances by connection identity, and the
env-configured one is a process-wide singleton, so neither could hold a
per-workspace value. Resolving them per job is also what lets an admin's change
take effect within the config TTL instead of at the next worker restart.

The confidence floor is the sharper of the two. A model that returns a relation
with no `confidence` field is read as asserting it (1), not as scoring it 0 —
the old default, which silently discarded every such relation at any threshold
above zero and could leave a correctly-configured workspace with an empty graph.

**Config resolves per call, not per boot.** `AssistantClient` methods take an
`AiCallContext` carrying the resolved config plus who to bill, and cache one
SDK instance per distinct (endpoint, credential, timeout). This is the change
with the widest blast radius in the feature and the reason the work landed
config-and-usage first, skills and plugins second.

**Credentials are encrypted, and the threat model is stated.** AES-256-GCM via
`node:crypto` (`ai/secret-box.ts`, same no-dependency decision as
`auth/password.ts`), keyed by `SETTINGS_ENCRYPTION_KEY`. That protects a
database dump or a replica; it does not protect against a compromised API
process, because the key lives on the same host. Keys are write-only over the
API — reads return `hasApiKey` and a last-4 hint. A missing key disables secret
_writes_ only, with a message pointing at `ASSISTANT_API_KEY`; everything else
keeps working. Each envelope is sealed to its place (#1106): `gcm2$<key id>$…`
with AAD `<table>.<column>:<workspace>:<row>` from `ai/secret-slots.ts`, so one
copied into another row, column or workspace does not decrypt; the first `gcm$`
format is still read and is rewritten when the row next saves its secret. A
stored key that will not decrypt (another key, a moved envelope) is reported as
`apiKeyUnreadable` on the settings and provider responses, shown on the
provider row, and the connection dials with no key: it never falls back to the
env credential.

**A key goes only to the endpoint it was given for** (GHSA-7hf4-5chc-29gr).
`ASSISTANT_API_KEY` is sent only to the env endpoint (`ASSISTANT_BASE_URL`, else
the env provider's default). A workspace row or named provider that dials
anywhere else must carry its own key, or it dials with none. A key-less named
provider borrows the default config's key only on the same endpoint. Saving a
new `baseUrl` or `provider` drops the stored key unless the same request sends
one. A workspace base URL is checked with `assertSafeExternalUrl` at save and
dialled through `safeFetch` (`providerFetch` in `ai/provider-endpoint.ts`, used
by the assistant client, OCR and extraction). A private or http address needs
`AI_PROVIDERS_ALLOW_PRIVATE_URLS=true`. The operator's own endpoint is always
allowed (`ResolvedAiConfig.privateOk`).

**Skills are trusted; plugin output is not.** A skill is written by a workspace
admin and sits next to the system prompt, so the prompt says plainly that
skills are instructions to follow — while adding that a skill can shape how the
assistant answers and never widen what it may access. An MCP server is a third
party, so its results are wrapped in `<plugin-result>` with the same
"DATA, not instructions" framing document content gets.

**Plugin tools are namespaced and HTTP-only.** `mcp__<slug>__<tool>` keeps a
plugin from ever shadowing a built-in tool and is what `runTool` routes on.
Only `streamable-http` and `sse` transports exist: stdio would mean spawning
processes on the API host on the strength of a URL typed into a form. SSE is
deprecated upstream and kept only as a compatibility path for servers that have
not migrated. Plugin URLs are DNS-resolved and refused when they land on
private, loopback, link-local or CGNAT ranges unless
`AI_PLUGINS_ALLOW_PRIVATE_URLS=true` — the self-hosted case where reaching an
internal service is the point.

Tools are offered from the cached `discoveredTools` (with the server's own
input schema when it publishes one), not a live `listTools()` per turn: a chat
must not wait on every registered server before the model can start. Admins
refresh explicitly with **Test**.

**One table serves usage and logs.** `ai_usage` holds one row per upstream
call, and the Usage tab aggregates exactly what the Logs tab lists. It stores
no prompt or completion text — that content already lives in
`assistant_messages`, and a second copy would bloat the table and duplicate
user data.

**Budgets are checked, not reserved.** `assertWithinBudget` runs before a call
and compares tokens already spent this month; a single call can therefore
overshoot its budget by its own size. Reserving up front would mean guessing
the completion length before generating it. Enforcement is opt-in
(`enforceBudget`), so existing installs only ever gain tracking.

**Streaming needed `stream_options.include_usage`.** Without it a streamed turn
carries no usage block at all and would have been invisible to accounting.
Providers that ignore the flag (several OpenAI-compatible servers do) get a
local ~4-chars-per-token estimate, flagged `estimated` so the UI can mark it
rather than implying billing truth.

## Surface

**Tables** — `ai_settings` (PK = workspaceId), `ai_providers`,
`ai_models`, `ai_user_budgets`, `ai_skills`, `ai_plugins`, `ai_usage`. Migrations
`20260908072710_ai_settings`, `20260908082134_ai_provider_profiles` and
`20270102100000_ai_models`, which only adds, so the retired `*_provider_id`, `model`,
price and capability columns are still there for the previous image to roll back over.

**Module** — `apps/api/src/ai/`, API-only (out of worker and MCP contexts).
It and `AssistantModule` `forwardRef` each other: a turn needs config, usage,
skills and plugins; **Test connection** needs `AssistantClient`.

**Routes** — `GET/PATCH /v1/ai/settings`, `POST /v1/ai/settings/test`;
`GET/POST /v1/ai/skills`, `GET/PATCH/DELETE /v1/ai/skills/:id`;
`GET/POST /v1/ai/plugins`, `PATCH/DELETE /v1/ai/plugins/:id`,
`POST /v1/ai/plugins/:id/test`; `GET /v1/ai/usage`, `/usage/logs`, `/usage/me`,
`GET /v1/ai/budgets`, `PUT/DELETE /v1/ai/budgets/:userId`;
`GET/POST /v1/ai/providers`, `PATCH/DELETE /v1/ai/providers/:id`;
`GET/POST /v1/ai/models`, `PATCH/DELETE /v1/ai/models/:id`, `POST /v1/ai/models/discover`,
and `GET /v1/ai/models/choices` (viewer — code and provider name only, never
endpoints or credentials). `PATCH /v1/assistant/threads/:id` takes `modelId`. The
`WorkspaceSource` values `ai-skill`, `ai-plugin`, `ai-provider` and `ai-model` resolve
`:id` to its owning workspace so an admin of one workspace cannot edit another's.

**Web** — `/settings/ai` (`AiSettingsPage.vue` + `components/ai/*Panel.vue`),
gated on workspace admin in the page. Since issue #182 the tabs are a grouped
section rail, each section its own URL — `/settings/ai/<section>`, rendered by
`modules/assistant/pages/AiSectionPage.vue` from the registry in `modules/assistant/model/ai-sections.ts` — and
Connect AI (feature 33) is the first section. `/settings/ai?tab=<x>` and
`/settings/connect` redirect, and bare `/settings/ai` opens Connect, the one
section every role can use. The usage chart is inline markup rather
than a charting library: the repo ships none and one bar series does not
justify adding one. The chat composer gained a skill picker (`SkillPicker.vue`)
that sends `skillIds` with the turn, plus a `ModelPicker.vue` that pins the
thread to a model (hidden entirely when the workspace offers none).

## Not done

- **No usage rollup table.** Aggregates scan `ai_usage` over an index, folded
  per-day in Node because Prisma's `groupBy` has no `date_trunc`. Fine at
  current volume; a monthly rollup is the escape hatch when it is not.
- **No stdio MCP transport** (see above) and no OAuth flow for plugins — a
  static header credential only.
- **Config cache is per-instance** with a 30 s TTL, so on a multi-node
  deployment a settings change can take up to one TTL to reach every node.
- **No model list sync.** A fetch happens when an admin asks; a model the provider
  stops serving stays until someone removes it, and fails at call time like any
  other upstream error.
- **No per-member shortlist and no per-model Test.** The admin curates for the
  workspace, and Test checks a connection.
