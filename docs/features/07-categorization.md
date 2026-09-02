# 07 — Categorization

> Оригинал: «Разделение на процессы, юз-кейсы, контракты, erd итд
> (категоризация)»

## What it is

Every document gets a category: `process`, `use-case`, `contract`, `erd`,
`architecture`, `guide`, `reference`, `other` (default).

## Design

- **DB**: `documents.category` (string, default `'other'`, indexed with
  `workspace_id`). Kept as a constrained string rather than a PG enum so the
  list can grow without a migration; the allowlist lives in
  `@knowledge/contracts` (`DOCUMENT_CATEGORIES`) and is validated in DTOs.
- **API**:
  - `POST /v1/documents` accepts `category`;
  - new `PATCH /v1/documents/:id` (`editor` role) updates
    `title` / `category` / `parentId` (shared with feature 08);
  - `GET /v1/documents?category=` filters the listing;
  - `DocumentSummary` carries `category` (and `parentId`).
- **Web**: category select in upload/editor, filter chips on the documents
  page, badges everywhere a document is shown, category filter in the search
  widget (feature 02).

## Future work

- Per-category templates in the editor (pre-filled frontmatter/skeleton).
- Category-scoped default relation types (e.g. `contract` → `IMPLEMENTS`).
