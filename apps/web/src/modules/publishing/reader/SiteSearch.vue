<script setup lang="ts">
/**
 * Search over the published version a reader is on (docs/features/44, #205).
 * The app's own search sheet — SearchSheetFrame, SearchPanel, SearchResults —
 * over the reader's source (site-search-source.ts) instead of the app's, with
 * the same "/" and ⌘K shortcut and the same focus return
 * (shared/utils/search-shortcut.ts). The rail offers only what the version's snapshot
 * carries: its categories and tags, never a workspace, project or mode.
 *
 * The one part of the reader that needs JavaScript: every page is still a
 * plain server render, and a result is a plain link to one.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { watchDebounced } from '@vueuse/core'
import { Search } from 'lucide-vue-next'
import type { DocumentCategory } from '@knowledge/contracts'
import { SITE_SEARCH_MIN_CHARS, type PublicSiteFacetsResponse } from '@knowledge/contracts/publishing'
import FacetFields from '@/modules/documents/components/FacetFields.vue'
import SearchSheetFrame from '@/modules/documents/components/SearchSheetFrame.vue'
import { useSearch } from '@/modules/documents/model/use-search'
import type { AutocompleteOption } from '@/shared/ui/autocomplete'
import { labelFor } from '@/shared/i18n/labels'
import { isSearchShortcut } from '@/shared/utils/search-shortcut'
import type { PublicSiteChrome } from './reader-state'
import { loadSiteFacets, siteSearchSource } from './site-search-source'

const props = defineProps<{ site: PublicSiteChrome; apiBase: string }>()

const { t } = useI18n()

const open = ref(false)
const search = useSearch(
  siteSearchSource(props.site, props.apiBase, {
    tooShort: t('siteReader.searchHint'),
    failed: t('siteReader.searchFailed'),
    limited: t('siteReader.searchRateLimited'),
  }),
)

// As in the app, a facet is offered only when it can tell pages apart: one
// category across the whole version filters nothing.
const facets = ref<PublicSiteFacetsResponse | null>(null)
watch(open, (isOpen) => {
  if (isOpen && !facets.value) void loadSiteFacets(props.site, props.apiBase).then((f) => (facets.value = f))
})
const categoryOptions = computed<AutocompleteOption[] | undefined>(() =>
  facets.value && facets.value.categories.length > 1
    ? facets.value.categories.map((c) => ({ value: c.value, label: labelFor(t, 'category', c.value), meta: c.count }))
    : undefined,
)
const tagOptions = computed<AutocompleteOption[] | undefined>(() =>
  facets.value?.tags.length ? facets.value.tags.map((tag) => ({ value: tag.key, label: tag.name, meta: tag.count })) : undefined,
)
const selectedCategories = computed({
  get: () => [...search.categories.value],
  // Free text in a snapshot as in `documents.category`; the Set's type is the app's vocabulary.
  set: (v: string[]) => (search.categories.value = new Set(v as DocumentCategory[])),
})
const selectedTags = computed({
  get: () => [...search.tags.value],
  set: (v: string[]) => (search.tags.value = new Set(v)),
})

// The snapshot's full-text search is cheap, so results follow the typing
// rather than waiting for Enter, as the reader always has.
watchDebounced(
  search.query,
  (q) => {
    if (q.trim().length < SITE_SEARCH_MIN_CHARS) search.reset()
    else void search.run()
  },
  { debounce: 150 },
)

function onGlobalKey(e: KeyboardEvent) {
  if (!isSearchShortcut(e)) return
  e.preventDefault()
  open.value = true
}

onMounted(() => window.addEventListener('keydown', onGlobalKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKey))
</script>

<template>
  <button
    id="site-search-trigger"
    type="button"
    class="inline-flex h-8 items-center gap-2 rounded-md border px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground sm:w-56"
    aria-haspopup="dialog"
    :aria-label="t('siteReader.search')"
    @click="open = true"
  >
    <Search class="size-4 shrink-0" aria-hidden="true" />
    <span class="hidden flex-1 text-left sm:inline">{{ t('siteReader.search') }}</span>
    <kbd class="hidden rounded border bg-muted px-1.5 font-mono text-micro sm:inline">/</kbd>
  </button>

  <SearchSheetFrame
    v-model:open="open"
    :search="search"
    trigger-id="site-search-trigger"
    :title="t('siteReader.search')"
    :description="t('siteReader.searchPlaceholder')"
    :placeholder="t('siteReader.searchPlaceholder')"
    content-class="sm:max-w-xl lg:max-w-4xl"
  >
    <template v-if="categoryOptions || tagOptions" #filters>
      <FacetFields
        v-model:categories="selectedCategories"
        v-model:tags="selectedTags"
        :category-options="categoryOptions"
        :tag-options="tagOptions"
      />
    </template>
  </SearchSheetFrame>
</template>
