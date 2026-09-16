# 09 — AI assistant

> Оригинал: «ИИ помощник при создании / ревью документов, автогенерации,
> подсказки, проверка на ошибки, поиск релевантных файлов»

## What it is (MVP scope)

Assistant endpoints backing an editor sidebar: LLM review of a draft, LLM
writing suggestions, and relevant-document lookup (which needs no LLM at all).

## Design

Mirrors the embeddings/extractor pattern — pluggable provider behind an env
switch, `none` by default, zero new hard dependencies:

- **Env**: `ASSISTANT_PROVIDER` = `none` | `openai-compatible` | `deepseek`,
  `ASSISTANT_BASE_URL` (must include `/v1`; defaulted for `deepseek`),
  `ASSISTANT_MODEL` (default `deepseek-chat` for `deepseek`),
  `ASSISTANT_API_KEY`, `ASSISTANT_MAX_TOOL_CALLS`, `ASSISTANT_TIMEOUT_MS`.
  Validated by zod in `config/env.ts`.
- **Module**: `src/assistant/` — `AssistantClient` (official `openai` SDK:
  chat, JSON mode, error mapping, and the bounded tool-calling loop),
  `AssistantToolsService` (tool definitions + session-authorized execution),
  `AssistantService`, `AssistantController`.
- **API** (all `viewer` role, workspace from body):
  - `POST /v1/assistant/review` — `{ workspaceId, title, markdown }` →
    `{ enabled, issues: [{ severity, message, section? }], summary }`.
    With provider `none` → `{ enabled: false, issues: [], summary }` so the
    UI can degrade gracefully instead of erroring.
  - `POST /v1/assistant/suggest` — `{ workspaceId, title, markdown,
instruction }` → `{ enabled, suggestion }` (outline, continuation,
    rewrite — the instruction decides).
  - `POST /v1/assistant/related` — `{ workspaceId, text, limit? }` → reuses
    `SearchService` (hybrid search over an excerpt of the draft). Works with
    the stub embedding provider; always enabled.
- **Web**: assistant panel in the editor (feature 03): Review button renders
  the issue list with severity badges; Related shows matching documents live;
  Suggest appends the model's text below the cursor. Disabled-provider state
  shows a hint about `ASSISTANT_PROVIDER`.

## Ask harness & access control

`POST /v1/assistant/ask` runs a bounded agentic loop (`ASSISTANT_MAX_TOOL_CALLS`,
default 24, ceiling 64) with four read-only tools: `search_knowledge` (hybrid
search + 1 graph hop), `read_document`, `explore_document_graph` and
`list_relations`. The default was 6, which one real question spent on
search → read ×2 → explore → list_relations before the harness forced a toolless
final round, so the model answered from half the evidence it had asked for. The
round ceiling is derived from the budget rather than fixed, or raising the budget
would buy nothing.

The four live in `AssistantReadToolsService`, which `AssistantToolsService`
delegates to — the same implementations the background agents run, so what the
chat offers and what an agent may call cannot drift apart. Containment against
context engineering / prompt injection:

- `workspaceId` is pinned server-side after AclGuard's membership check — tool
  arguments cannot name a workspace, so injected "read workspace X" text
  dead-ends.
- Every tool execution re-runs `AccessService.requireRole(principal, ws,
  'viewer')` against the *caller's session* — revoking access cuts the model
  off mid-conversation; the assistant can never read more than the user could.
- Model-supplied document ids are re-verified to belong to the pinned
  workspace before content is fetched.
- Retrieved content is framed as untrusted data in the system prompt (the
  model is told to flag embedded instructions, not follow them), tool errors
  return `{"error"}` payloads instead of stack traces, and when the budget is
  spent the final round runs without tools so the model must answer.
- The response reports `toolCalls` (tool, arguments, ok) and `model` for
  transparency; every touched document surfaces in `sources`.

## Future work

- Autogeneration of documents from templates + graph context.
- Review comments anchored to line ranges; MR-diff review mode.
- MCP tools (`knowledge_review_draft`) for agent-side authoring.
