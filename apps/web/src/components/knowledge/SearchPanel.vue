<script setup lang="ts">
// The whole search surface — filters rail, query field, results — shared by the
// global sheet (SearchSheet.vue) and the standalone /search page
// (SearchWidget.vue) so the two can never drift apart.
import { ref } from 'vue'
import { Search, SlidersHorizontal } from 'lucide-vue-next'
import { Button } from '@/components/ui/button'
import SearchFilters from './SearchFilters.vue'
import SearchResults from './SearchResults.vue'
import type { UseSearch } from './use-search'

withDefaults(
  defineProps<{
    search: UseSearch
    /** The sheet tints its rail to match the app shell; the page keeps the ground. */
    railSurface?: boolean
    placeholder?: string
  }>(),
  { railSurface: false, placeholder: 'Search every page…' },
)

const emit = defineEmits<{ navigate: []; 'switch-workspace': [workspaceId: string] }>()

const queryEl = ref<HTMLInputElement | null>(null)
const filtersOpen = ref(false)

defineExpose({ focusQuery: () => queryEl.value?.focus() })
</script>

<template>
  <div class="grid min-h-0 items-stretch lg:grid-cols-[15rem_minmax(0,1fr)]">
    <aside
      class="sidebar-scroll hidden min-h-0 overflow-y-auto lg:block"
      :class="
        railSurface
          ? 'border-r border-sidebar-border bg-sidebar p-4'
          : 'border-r pr-5'
      "
    >
      <SearchFilters
        :search="search"
        @switch-workspace="emit('switch-workspace', $event)"
      />
    </aside>

    <section class="flex min-h-0 flex-col">
      <div :class="railSurface ? 'border-b p-4 pr-14' : 'pb-4 pl-5'">
        <form role="search" class="flex gap-2" @submit.prevent="search.run()">
          <div class="relative flex-1">
            <Search
              class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              ref="queryEl"
              v-model="search.query.value"
              :placeholder="placeholder"
              aria-label="Search query"
              class="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/50"
            />
          </div>
          <Button type="submit" :disabled="search.busy.value || !search.query.value.trim()">
            {{ search.busy.value ? 'Searching…' : 'Search' }}
          </Button>
        </form>

        <div class="mt-2 flex items-center gap-3">
          <button
            type="button"
            class="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground lg:hidden"
            :aria-expanded="filtersOpen"
            @click="filtersOpen = !filtersOpen"
          >
            <SlidersHorizontal class="size-3.5" />
            Filters
            <span v-if="search.activeFilterCount.value" class="text-primary">
              ({{ search.activeFilterCount.value }})
            </span>
          </button>
          <div class="ml-auto"><slot name="actions" /></div>
        </div>
      </div>

      <!-- Same filters component, second mount point: no duplicated markup. -->
      <div
        v-if="filtersOpen"
        class="max-h-[45vh] overflow-y-auto border-b lg:hidden"
        :class="railSurface ? 'p-4' : 'py-4'"
      >
        <SearchFilters
          :search="search"
          @switch-workspace="emit('switch-workspace', $event)"
        />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto" :class="railSurface ? 'p-4' : 'pl-5'">
        <SearchResults
          :response="search.response.value"
          :busy="search.busy.value"
          :error="search.error.value"
          :active-filter-count="search.activeFilterCount.value"
          @navigate="emit('navigate')"
          @clear-filters="search.clearFilters()"
        />
      </div>
    </section>
  </div>
</template>
