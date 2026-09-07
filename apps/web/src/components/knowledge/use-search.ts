// Shared search state + request assembly for the search sheet (SearchSheet.vue)
// and the standalone /search page (SearchWidget.vue). Both surfaces must build
// the same SearchRequest, so the body assembly lives here rather than in either.
import { computed, ref } from 'vue'
import type { DocumentCategory, SearchRequest, SearchResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'

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

/**
 * A factory, not a singleton: each mount gets isolated state, which keeps it
 * SSR-safe (no state shared across requests) and lets the sheet and the page
 * hold independent queries.
 */
export function useSearch(initial?: Partial<SearchSnapshot>) {
  const query = ref(initial?.query ?? '')
  const mode = ref<SearchMode>(initial?.mode ?? 'hybrid')
  const categories = ref<Set<DocumentCategory>>(new Set(initial?.categories ?? []))
  const projectIds = ref<Set<string>>(new Set(initial?.projectIds ?? []))
  const tags = ref<Set<string>>(new Set(initial?.tags ?? []))
  const expand = ref(initial?.expand ?? true)
  const depth = ref(initial?.depth ?? 1)
  const limit = ref(initial?.limit ?? 20)

  const response = ref<SearchResponse | null>(null)
  const busy = ref(false)
  const error = ref<string | null>(null)

  // Monotonic ticket: filter toggles re-run the query, so a slow request must
  // not overwrite the results of a newer one.
  let seq = 0

  const activeFilterCount = computed(
    () => categories.value.size + projectIds.value.size + tags.value.size,
  )
  const hasSearched = computed(() => response.value !== null)

  function buildRequest(): SearchRequest {
    const hasFilters =
      categories.value.size > 0 || projectIds.value.size > 0 || tags.value.size > 0
    return {
      workspaceId: getWorkspaceId(),
      query: query.value,
      mode: mode.value,
      limit: limit.value,
      ...(expand.value && mode.value === 'hybrid' ? { expandGraph: { depth: depth.value } } : {}),
      ...(hasFilters
        ? {
            filters: {
              ...(categories.value.size > 0 ? { categories: [...categories.value] } : {}),
              ...(projectIds.value.size > 0 ? { projectIds: [...projectIds.value] } : {}),
              ...(tags.value.size > 0 ? { tags: [...tags.value] } : {}),
            },
          }
        : {}),
    }
  }

  async function run() {
    if (!query.value.trim()) return
    const ticket = ++seq
    busy.value = true
    error.value = null
    try {
      const res = await apiFetch<SearchResponse>('/v1/search', {
        method: 'POST',
        body: JSON.stringify(buildRequest()),
      })
      if (ticket !== seq) return
      response.value = res
    } catch (e) {
      if (ticket === seq) error.value = (e as Error).message
    } finally {
      if (ticket === seq) busy.value = false
    }
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
    toggleCategory,
    toggleProject,
    toggleTag,
    clearFilters,
    snapshot,
  }
}

export type UseSearch = ReturnType<typeof useSearch>
