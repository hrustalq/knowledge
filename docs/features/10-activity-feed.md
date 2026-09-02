# 10 — Activity feed

> Оригинал: «Логи других пользователей (лента как в jira/confluence)»

## What it is

A Jira/Confluence-style activity stream: who did what, when, to which
document — workspace-wide and filterable per document.

## Design

- **DB**: `activity_log` table — `id`, `workspace_id`, `actor` (user id or the
  synthetic dev principal), `action`, `document_id?`, `subject_id?` (revision /
  MR / branch id), `metadata` JSON, `created_at`; indexed by
  `(workspace_id, created_at)` and `(document_id, created_at)`.
  Distinct from Phase 5 `audit_logs`, which is a security audit of
  trusted-operator graph queries — different retention and audience; the two
  are deliberately not merged.
- **API**: `ActivityModule` (`@Global`-free, imported where needed) with
  `ActivityService.record(...)` — fire-and-forget (failures logged, never
  thrown into the user's request) and every record is also published to the
  event bus (feature 04), so feeds update live.
  Recorded actions: `document.created`, `document.updated` (rename / category /
  move), `revision.finalized`, `branch.created`, `relations.curated`,
  `relations.deleted`, `merge-request.created` / `.approved` / `.merged` /
  `.closed`.
  Surface: `GET /v1/activity?workspaceId=&documentId=&limit=&cursor=`
  (`viewer` role) → `ListActivityResponse`.
- **Web**: `/activity` page — the feed with actor, humanized action, document
  link and relative time, updating live via SSE; the document page gets an
  Activity section scoped by `documentId`.

## Future work

- Per-user profiles / avatars once real users exist beyond api-key bootstrap.
- Digest notifications (daily email/webhook).
