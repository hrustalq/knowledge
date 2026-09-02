# 02 — Search widget with filters

> Оригинал: «Виджет поиска с фильтрами»

## What it is

A reusable search component with visible controls for everything the search
API can already do, plus metadata filters.

## Design

- **Contracts**: `SearchRequest` gains `filters?: { categories?: string[] }`.
  Categories come from feature 07.
- **API**: `SearchService` applies the category filter after rank fusion by
  joining PG (`documents.category`) — the three-store separation holds: the
  graph ranks, PG owns metadata. Filtered-out hits do not shrink the requested
  limit (the filter runs before slicing).
- **Web**: `SearchWidget.vue` — a self-contained component used by
  `SearchPage`. Controls:
  - query input;
  - mode select (`hybrid` / `semantic` / `keyword`);
  - category multi-select chips;
  - graph expansion toggle + depth (1–3);
  - result limit.
    Results render with score, snippet, category badge and attached entities;
    graph-expansion `related[]` documents render in a separate "Related via
    graph" section with the connecting edges as evidence.

## Future work

- Filter by entity/relation type (the API can already do
  `expandGraph.relationTypes`; the widget exposes only depth for now).
- Saved searches / URL-encoded search state.
