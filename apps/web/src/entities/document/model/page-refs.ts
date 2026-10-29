/**
 * Resolving a page reference written as a *title*.
 *
 * Authors reach for a page by the name they see in the sidebar —
 * `[Модель данных](OrderHub — Модель данных)` — and the assistant does it more
 * than anyone, because when it splits a page it names the children it intends
 * to create before any of them has an id. CommonMark reads none of that as a
 * link (an unescaped space ends a destination), so the brackets survive into
 * the rendered page as punctuation.
 *
 * This module supplies the title -> id half; `lib/markdown/render` does the
 * parsing half. Both are read-time only: the markdown on disk keeps the title
 * the author wrote, so renaming a page changes what its references resolve to
 * on the next render instead of stranding a dead id in every page that
 * mentioned it — the same trade `lib/glossary` makes, for the same reason.
 *
 * The functions live in `@knowledge/contracts` (#74): the API's quality auditor
 * reports a reference as broken exactly when this resolver leaves it as text.
 */
export {
  buildPageRefResolver,
  mayContainPageRef,
  pageRefKey,
  pageTitleHref,
  type PageRef,
  type PageRefResolver,
} from '@knowledge/contracts'
