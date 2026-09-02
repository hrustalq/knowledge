# 05 — Revision viewer

> Оригинал: «Просмотр ревизий документа»

## What it is

A **Revisions** tab on the document page: the revision DAG, branches, and an
inline two-revision compare — all on top of existing Phase 2/3 endpoints
(`GET /:id/revisions`, `GET /:id/branches`, `GET /:id/compare`). No backend
changes.

## Design

- Revision list (newest first): number, short id, branch, status badge,
  message, author time, parent revision ids (merge revisions show two).
- Branch filter (dropdown fed by `GET /:id/branches`).
- Compare: pick any two finalized revisions ("from"/"to" radio per row) →
  `GET /:id/compare?from&to&mode=merge-base` → unified diff rendered from
  `hunks` with added/deleted line colouring, plus the structural-diff summary
  when present.
- "View" per revision routes to the Content tab with `?revision=` (feature 01
  endpoint accepts any finalized revision).

## Future work

- Graphical DAG (SVG lanes like GitLab's network graph).
- Restore-this-revision action (creates a new head revision with old content).
