# 12 — AI settings

Оригинал: «add ai settings to settings page — we should be able to configure ai,
add skills, add plugins, see token spent per user, logs»

## What this is

A fifth section in `/settings` that makes the assistant layer administrable
from the UI instead of from `.env` and a restart. Five tabs:

| Tab               | What it does                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **Configuration** | Provider, endpoint, model, API key, temperature, tool budget, timeout, Agent-mode switch, budgets, cost-estimate prices. |
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

**Multiple providers, routed per purpose.** A workspace can define named
profiles (`ai_providers`) — "DeepSeek prod", "Local Ollama" — and route each of
the three jobs at one of them: chat and agent turns, background review and
suggestion, and the worker's relation extraction. A member can also pin one
profile to their own chat thread. Resolution is first-hit-wins: thread pin →
the purpose's route → the inline default config → the `ASSISTANT_*` env vars.
That last step is what keeps it additive — a workspace with no profiles
resolves exactly as it did before they existed, and a routed profile that is
later disabled or deleted falls through rather than failing the turn.

Deleting a profile clears every route and thread pin that referenced it, which
is the trade for the routing columns carrying no foreign key (house style —
see `assignee_id`). Cross-tenant ids are rejected at both ends: the pin is
validated on write, and `resolveFor` re-checks the workspace on read.

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
keeps working. A row that will not decrypt (rotated key, corrupt envelope)
falls back to the env credential rather than taking the assistant down.

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
`ai_user_budgets`, `ai_skills`, `ai_plugins`, `ai_usage`. Migrations
`20260908072710_ai_settings` and `20260908082134_ai_provider_profiles`.

**Module** — `apps/api/src/ai/`, API-only (out of worker and MCP contexts).
It and `AssistantModule` `forwardRef` each other: a turn needs config, usage,
skills and plugins; **Test connection** needs `AssistantClient`.

**Routes** — `GET/PATCH /v1/ai/settings`, `POST /v1/ai/settings/test`;
`GET/POST /v1/ai/skills`, `GET/PATCH/DELETE /v1/ai/skills/:id`;
`GET/POST /v1/ai/plugins`, `PATCH/DELETE /v1/ai/plugins/:id`,
`POST /v1/ai/plugins/:id/test`; `GET /v1/ai/usage`, `/usage/logs`, `/usage/me`,
`GET /v1/ai/budgets`, `PUT/DELETE /v1/ai/budgets/:userId`;
`GET/POST /v1/ai/providers`, `PATCH/DELETE /v1/ai/providers/:id`, and
`GET /v1/ai/providers/choices` (viewer — names and models only, never
endpoints or credentials). `PATCH /v1/assistant/threads/:id` gained
`providerId`. Three new `WorkspaceSource` values — `ai-skill`, `ai-plugin`,
`ai-provider` — resolve `:id` to its owning workspace so an admin of one
workspace cannot edit another's.

**Web** — `/settings/ai` (`AiSettingsPage.vue` + `components/ai/*Panel.vue`),
gated on workspace admin in the page. The usage chart is inline markup rather
than a charting library: the repo ships none and one bar series does not
justify adding one. The chat composer gained a skill picker (`SkillPicker.vue`)
that sends `skillIds` with the turn, plus a `ModelPicker.vue` that pins the
thread to a profile (hidden entirely when the workspace defines none).

## Not done

- **No usage rollup table.** Aggregates scan `ai_usage` over an index, folded
  per-day in Node because Prisma's `groupBy` has no `date_trunc`. Fine at
  current volume; a monthly rollup is the escape hatch when it is not.
- **No stdio MCP transport** (see above) and no OAuth flow for plugins — a
  static header credential only.
- **Config cache is per-instance** with a 30 s TTL, so on a multi-node
  deployment a settings change can take up to one TTL to reach every node.
