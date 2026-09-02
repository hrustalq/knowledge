# 09 — AI assistant

> Оригинал: «ИИ помощник при создании / ревью документов, автогенерации,
> подсказки, проверка на ошибки, поиск релевантных файлов»

## What it is (MVP scope)

Assistant endpoints backing an editor sidebar: LLM review of a draft, LLM
writing suggestions, and relevant-document lookup (which needs no LLM at all).

## Design

Mirrors the embeddings/extractor pattern — pluggable provider behind an env
switch, `none` by default, zero new hard dependencies:

- **Env**: `ASSISTANT_PROVIDER` = `none` | `openai-compatible`,
  `ASSISTANT_BASE_URL` (must include `/v1`), `ASSISTANT_MODEL`,
  `ASSISTANT_API_KEY`. Validated by zod in `config/env.ts`.
- **Module**: `src/assistant/` — provider token + OpenAI-compatible chat
  client (JSON-mode prompts), `AssistantService`, `AssistantController`.
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

## Future work

- Autogeneration of documents from templates + graph context.
- Review comments anchored to line ranges; MR-diff review mode.
- MCP tools (`knowledge_review_draft`) for agent-side authoring.
