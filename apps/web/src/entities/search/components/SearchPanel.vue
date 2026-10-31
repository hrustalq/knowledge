<script setup lang="ts">
// The whole search surface — filters rail, query field, results — shared by the
// global sheet (SearchSheet.vue), the standalone /search page (SearchWidget.vue)
// and a published site's reader (SiteSearch.vue, #205) so they can never drift
// apart. Store-free: each surface passes the filters it offers in the
// `filters` slot, drawn twice — the desktop rail and the mobile disclosure.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, ref, useId, watch } from 'vue'
import { Search, SlidersHorizontal } from 'lucide-vue-next'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { nativeEl } from '@/shared/utils/cn'
import SearchResults from './SearchResults.vue'
import type { SearchCopy, UseSearch } from '../model/use-search'

const { t } = useI18n()

const props = withDefaults(
  defineProps<{
    search: UseSearch
    /** The sheet tints its rail to match the app shell; the page keeps the ground. */
    railSurface?: boolean
    placeholder?: string
    copy?: SearchCopy
  }>(),
  { railSurface: false, placeholder: '' },
)

const emit = defineEmits<{ navigate: [] }>()
defineSlots<{ filters?(): unknown; actions?(): unknown }>()

const queryEl = ref<HTMLInputElement | null>(null)
const setQueryEl = (c: unknown) => {
  queryEl.value = nativeEl<HTMLInputElement>(c)
}
const filtersOpen = ref(false)

defineExpose({ focusQuery: () => queryEl.value?.focus() })

/**
 * The query field drives the results as a listbox (#651), the command-palette
 * way: focus stays in the field so typing goes on working, ↑/↓ move a row
 * marked by `aria-activedescendant`, and Enter opens it by clicking the row's
 * own link — the router link in the app, a plain link in a site's reader.
 */
const listId = useId()
const active = ref(-1)
const results = computed(() => props.search.response.value?.results ?? [])
watch(results, () => (active.value = -1))
watch(active, async (i) => {
  if (i < 0) return
  await nextTick()
  document.getElementById(`${listId}-${i}`)?.scrollIntoView({ block: 'nearest' })
})

function onQueryKey(e: KeyboardEvent) {
  const n = results.value.length
  if (!n || e.isComposing) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    active.value = Math.min(n - 1, active.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    active.value = Math.max(-1, active.value - 1)
  } else if (e.key === 'Enter' && active.value >= 0) {
    // Opening a row, not running the search again.
    e.preventDefault()
    document.getElementById(`${listId}-${active.value}`)?.click()
  }
}

function clearLabel() {
  const n = props.search.activeFilterCount.value
  return t('search.clearFilters', { filters: t('search.activeFilters', { n }, n) })
}
</script>

<template>
  <!-- minmax(0,…) on every breakpoint: an auto column grows to the widest
       unbreakable snippet and pushes the query field off a phone screen. -->
  <div
    class="grid min-h-0 grid-cols-[minmax(0,1fr)] items-stretch"
    :class="$slots.filters ? 'lg:grid-cols-[15rem_minmax(0,1fr)]' : ''"
  >
    <aside
      v-if="$slots.filters"
      class="quiet-scroll hidden min-h-0 overflow-y-auto lg:block"
      :class="
        railSurface
          ? 'border-r border-sidebar-border bg-sidebar p-4'
          : 'border-r pr-5'
      "
    >
      <div class="space-y-5">
        <slot name="filters" />
        <button
          v-if="search.activeFilterCount.value > 0"
          type="button"
          class="text-xs text-primary hover:underline"
          @click="search.clearFilters()"
        >
          {{ clearLabel() }}
        </button>
      </div>
    </aside>

    <section class="flex min-h-0 flex-col">
      <div :class="railSurface ? 'border-b p-4 pr-14' : $slots.filters ? 'pb-4 lg:pl-5' : 'pb-4'">
        <form role="search" class="flex gap-2" @submit.prevent="search.run()">
          <div class="relative flex-1">
            <Search
              class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              :ref="setQueryEl"
              v-model="search.query.value"
              :placeholder="placeholder || t('search.searchEveryPagePlaceholder')"
              :aria-label="t('search.query')"
              role="combobox"
              aria-autocomplete="list"
              :aria-expanded="results.length > 0"
              :aria-controls="listId"
              :aria-activedescendant="active >= 0 ? `${listId}-${active}` : undefined"
              class="pl-8"
              @keydown="onQueryKey"
            />
          </div>
          <Button type="submit" :disabled="search.busy.value || !search.query.value.trim()">
            {{ search.busy.value ? t('search.searching') : t('nav.search') }}
          </Button>
        </form>

        <div class="mt-2 flex items-center gap-3">
          <button
            v-if="$slots.filters"
            type="button"
            class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground lg:hidden"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = !filtersOpen"
          >
            <SlidersHorizontal class="size-3.5" />
            {{ t('search.filters') }}
            <span v-if="search.activeFilterCount.value" class="text-primary">
              ({{ search.activeFilterCount.value }})
            </span>
          </button>
          <div class="ml-auto"><slot name="actions" /></div>
        </div>
      </div>

      <!-- Same filters component, second mount point: no duplicated markup. -->
      <div
        v-if="$slots.filters && filtersOpen"
        class="max-h-[45vh] space-y-5 overflow-y-auto border-b lg:hidden"
        :class="railSurface ? 'p-4' : 'py-4'"
      >
        <slot name="filters" />
        <button
          v-if="search.activeFilterCount.value > 0"
          type="button"
          class="text-xs text-primary hover:underline"
          @click="search.clearFilters()"
        >
          {{ clearLabel() }}
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto" :class="railSurface ? 'p-4' : $slots.filters ? 'lg:pl-5' : ''">
        <SearchResults
          :response="search.response.value"
          :busy="search.busy.value"
          :error="search.error.value"
          :active-filter-count="search.activeFilterCount.value"
          :copy="copy"
          :list-id="listId"
          :active-index="active"
          @navigate="emit('navigate')"
          @clear-filters="search.clearFilters()"
        />
      </div>
    </section>
  </div>
</template>
