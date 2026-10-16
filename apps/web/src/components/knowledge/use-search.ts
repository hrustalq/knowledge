// Shared search state for every search surface: the app's sheet (SearchSheet.vue),
// the standalone /search page (SearchWidget.vue) and a published site's reader
// (pages/public/SiteSearch.vue). Store-free on purpose — the reader has no
// Pinia, router or auth — so where results come from is a `SearchSource` the
// caller passes: the app's is app-search-source.ts, the reader's the public
// site search route.
import { computed, ref } from 'vue'
import type { DocumentCategory, SourceVerificationState } from '@knowledge/contracts'

export type SearchMode = 'hybrid' | 'semantic' | 'keyword'

/** Flat, JSON-serializable state — survives the workspace-switch reload. */
export interface SearchSnapshot {
  query: string
  mode: SearchMode
  categories: DocumentCategory[]
  projectIds: string[]
  /** Tag entity keys, e.g. 'tag:security'. */
  tags: string[]
  expand: boolean
  depth: number
  limit: number
}

/** A run of snippet text; `hit` marks words the query matched. Never HTML. */
export interface SearchSnippetPart {
  text: string
  hit: boolean
}

/**
 * One result row as SearchResults draws it, whichever source found it. A row
 * links with `to` (a router path, in the app) or `href` (a plain link, in the
 * reader, which has no router).
 */
export interface SearchHit {
  key: string
  title: string
  to?: string
  href?: string
  snippet: SearchSnippetPart[]
  /** Omitted where the source does not rank by a score worth showing. */
  score?: number
  trust?: SourceVerificationState
  badges: { key: string; label: string }[]
}

export interface SearchRelatedHit {
  key: string
  title: string
  to: string
  distance: number
  via: string
}

export interface SearchView {
  results: SearchHit[]
  related: SearchRelatedHit[]
}

export type SearchSource = (state: SearchSnapshot) => Promise<SearchView>

/**
 * Thrown by a source whose message is already what the reader should read
 * ("too many searches, wait a minute"), so it is shown as it is rather than
 * wrapped in the generic connection error.
 */
export class SearchNotice extends Error {}

export interface SearchFailure {
  message: string
  notice: boolean
}

/**
 * A factory, not a singleton: each mount gets isolated state, which keeps it
 * SSR-safe (no state shared across requests) and lets the sheet and the page
 * hold independent queries.
 */
export function useSearch(source: SearchSource, initial?: Partial<SearchSnapshot>) {
  const query = ref(initial?.query ?? '')
  const mode = ref<SearchMode>(initial?.mode ?? 'hybrid')
  const categories = ref<Set<DocumentCategory>>(new Set(initial?.categories ?? []))
  const projectIds = ref<Set<string>>(new Set(initial?.projectIds ?? []))
  const tags = ref<Set<string>>(new Set(initial?.tags ?? []))
  const expand = ref(initial?.expand ?? true)
  const depth = ref(initial?.depth ?? 1)
  const limit = ref(initial?.limit ?? 20)

  const response = ref<SearchView | null>(null)
  const busy = ref(false)
  const error = ref<SearchFailure | null>(null)

  // Monotonic ticket: filter toggles re-run the query, so a slow request must
  // not overwrite the results of a newer one.
  let seq = 0

  const activeFilterCount = computed(
    () => categories.value.size + projectIds.value.size + tags.value.size,
  )
  const hasSearched = computed(() => response.value !== null || error.value !== null)

  async function run() {
    if (!query.value.trim()) return
    const ticket = ++seq
    busy.value = true
    error.value = null
    try {
      const res = await source(snapshot())
      if (ticket !== seq) return
      response.value = res
    } catch (e) {
      if (ticket !== seq) return
      // A failed search shows its failure, not the results of an older query.
      response.value = null
      error.value = { message: (e as Error).message, notice: e instanceof SearchNotice }
    } finally {
      if (ticket === seq) busy.value = false
    }
  }

  /** Drop the results and any failure, as an emptied query field does. */
  function reset() {
    seq++
    busy.value = false
    response.value = null
    error.value = null
  }

  function toggle<T>(set: { value: Set<T> }, item: T) {
    const next = new Set(set.value)
    if (next.has(item)) next.delete(item)
    else next.add(item)
    set.value = next
  }

  const toggleCategory = (c: DocumentCategory) => toggle(categories, c)
  const toggleProject = (id: string) => toggle(projectIds, id)
  const toggleTag = (key: string) => toggle(tags, key)

  function clearFilters() {
    categories.value = new Set()
    projectIds.value = new Set()
    tags.value = new Set()
  }

  function snapshot(): SearchSnapshot {
    return {
      query: query.value,
      mode: mode.value,
      categories: [...categories.value],
      projectIds: [...projectIds.value],
      tags: [...tags.value],
      expand: expand.value,
      depth: depth.value,
      limit: limit.value,
    }
  }

  return {
    query,
    mode,
    categories,
    projectIds,
    tags,
    expand,
    depth,
    limit,
    response,
    busy,
    error,
    activeFilterCount,
    hasSearched,
    run,
    reset,
    toggleCategory,
    toggleProject,
    toggleTag,
    clearFilters,
    snapshot,
  }
}

export type UseSearch = ReturnType<typeof useSearch>
