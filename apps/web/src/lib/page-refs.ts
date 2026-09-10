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
 */

/**
 * Resolves a page *title* to its document id, or null when nothing in the
 * workspace carries that title. Supplied per render by the caller, because the
 * roster is app state and `lib/markdown/render` is a pure parser.
 */
export type PageRefResolver = (title: string) => string | null

/**
 * Titles are compared on collapsed whitespace, case-insensitively.
 *
 * Both halves earn their place: a title that wrapped in the source arrives with
 * a newline in it, and the model routinely varies the case of a word it is
 * quoting back. Nothing else is normalised — em dashes, colons and punctuation
 * are part of the title, and a reference that differs in those is a reference
 * to something else.
 */
export function pageRefKey(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** A page as the roster knows it: enough to resolve a title, and no more. */
export interface PageRef {
  documentId: string
  title: string
  /** Which project it lives in — the tiebreak when a title is not unique. */
  projectId?: string | null
}

/**
 * Build a resolver over the pages currently known to the app.
 *
 * Titles are not unique across a workspace — the same page name recurs in every
 * project that documents the same thing — so a title alone can be ambiguous.
 * `preferProjectId` is the tiebreak that makes the common case work: a
 * reference written on a page in project X almost always means the page of that
 * name in project X, which is the containment feature 11 exists to express.
 *
 * When that still leaves more than one, the reference resolves to **nothing**.
 * Picking the first would send readers somewhere plausible and wrong, and a
 * reference that kept its brackets at least says it is unresolved.
 */
export function buildPageRefResolver(
  pages: readonly PageRef[],
  preferProjectId?: string | null,
): PageRefResolver {
  const byTitle = new Map<string, PageRef[]>()
  for (const page of pages) {
    const key = pageRefKey(page.title)
    if (!key) continue
    const bucket = byTitle.get(key)
    if (bucket) bucket.push(page)
    else byTitle.set(key, [page])
  }
  return (title) => {
    const matches = byTitle.get(pageRefKey(title))
    if (!matches?.length) return null
    if (matches.length === 1) return matches[0].documentId
    const local = preferProjectId
      ? matches.filter((p) => p.projectId === preferProjectId)
      : []
    return local.length === 1 ? local[0].documentId : null
  }
}

/**
 * A link destination that could be a page title rather than a location.
 *
 * Anything that addresses something — a scheme, a root-relative path, an
 * in-page anchor — is a location, and comes back null. What is left is a bare
 * relative reference, which this product has no other use for: there are no
 * relative paths between pages, only `/documents/<id>`.
 *
 * The percent-decoding is the whole point of the second form. A model that
 * escapes the title it is linking to produces a destination with no spaces in
 * it, so CommonMark *accepts* it and the reader gets a relative link to
 * `OrderHub%20%E2%80%94%20…` that 404s — the same authored intent as the
 * unencoded form, and invisible to any check that looks for a space.
 * A malformed escape decodes to itself rather than throwing.
 */
export function pageTitleHref(href: string): string | null {
  if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('/') || href.startsWith('#')) {
    return null
  }
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

const LINK_RE = /\[[^[\]\n]+\]\(([^()\n]*)\)/g

/**
 * Cheap pre-check: is it even worth loading the page roster for this text?
 *
 * Most markdown this app renders is a comment or a chat reply with no page
 * reference in it at all, and the roster costs a request. Both spellings count:
 * a destination containing a space (which CommonMark refuses outright, so it
 * never becomes a link) and a bare relative one (which it accepts, and which
 * then goes nowhere). Whether either *resolves* is the resolver's business.
 */
export function mayContainPageRef(markdown: string): boolean {
  for (const match of markdown.matchAll(LINK_RE)) {
    const destination = match[1]
    if (!destination) continue
    if (/\s/.test(destination) || pageTitleHref(destination)) return true
  }
  return false
}
