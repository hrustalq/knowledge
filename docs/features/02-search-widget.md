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
- **One row per page** (#443): the app sends `groupBy: 'page'`. `SearchService`
  keeps each page's best-ranked chunk after the trust re-sort (`firstPerPage`)
  and only then cuts to `limit`, so the limit counts pages. The chunk pool is
  over-fetched 3× and refilled once (as for page restrictions) when it still
  names fewer than `limit` pages.
- **Highlighted snippets** (#443): with `groupBy: 'page'` each result carries
  `snippetParts`, built by `search/snippet.ts`: a 300-character window opening
  near the first query match, every match a `hit` run that `SearchResults.vue`
  draws as `<mark>`. Query words are folded (NFC, case) and matched as prefixes
  with the last two letters of a long word cut, so `сервис` marks `сервиса` and
  back. A naive stemmer on purpose: it matches neither the BM25 analyzers nor
  meaning, and a vector-only hit with no shared word shows no mark. `snippet`
  stays the chunk's opening for MCP and the assistant.

## Future work

- Filter by entity/relation type (the API can already do
  `expandGraph.relationTypes`; the widget exposes only depth for now).
- Saved searches / URL-encoded search state.
