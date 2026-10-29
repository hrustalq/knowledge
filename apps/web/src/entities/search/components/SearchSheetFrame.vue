<script setup lang="ts">
// The search sheet itself — Sheet, query, filters rail, results — with no
// stores, router or auth, so the app's global search (SearchSheet.vue) and a
// published site's reader (SiteSearch.vue, #205) open the same sheet. Whoever
// mounts it owns the open state, the source and which filters it offers.
//
// Opened programmatically ("/", Cmd/Ctrl+K, a trigger button), so focus is
// handed back by hand on close (shared/utils/search-shortcut.ts).
import { nextTick, ref, watch } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { createFocusReturn } from '@/shared/utils/search-shortcut'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/shared/ui/sheet'
import SearchPanel from './SearchPanel.vue'
import type { UseSearch } from '../model/use-search'

const props = withDefaults(
  defineProps<{
    search: UseSearch
    /** The element that opened the sheet when no other had focus. */
    triggerId: string
    title: string
    description: string
    placeholder?: string
    contentClass?: string
  }>(),
  { placeholder: '', contentClass: 'sm:max-w-3xl lg:max-w-5xl' },
)
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ navigate: [] }>()
defineSlots<{ filters?(): unknown; actions?(): unknown; footer?(): unknown }>()

const panelEl = ref<InstanceType<typeof SearchPanel> | null>(null)

/** Focus the query field rather than the close button. */
function focusQuery() {
  void nextTick(() => panelEl.value?.focusQuery())
}

const focusReturn = createFocusReturn(props.triggerId)
watch(open, (isOpen) => {
  if (isOpen) focusReturn.remember()
})

// Toggling a facet re-runs the query — but only once there are results to
// refine, so flipping filters before the first search fires nothing. Read
// field by field: a getter that touched the query would fire on every keystroke.
watchDebounced(
  () => {
    const s = props.search
    return [
      s.mode.value,
      [...s.categories.value],
      [...s.projectIds.value],
      [...s.tags.value],
      s.expand.value,
      s.depth.value,
      s.limit.value,
    ]
  },
  () => {
    if (props.search.hasSearched.value && props.search.query.value.trim()) void props.search.run()
  },
  { debounce: 250, deep: true },
)
</script>

<template>
  <Sheet v-model:open="open">
    <SheetContent
      side="right"
      class="w-full gap-0 p-0"
      :class="contentClass"
      @open-auto-focus.prevent="focusQuery"
      @close-auto-focus="focusReturn.onCloseAutoFocus"
    >
      <SheetHeader class="sr-only">
        <SheetTitle>{{ title }}</SheetTitle>
        <SheetDescription>{{ description }}</SheetDescription>
      </SheetHeader>

      <SearchPanel
        ref="panelEl"
        class="min-h-0 flex-1"
        rail-surface
        :search="search"
        :placeholder="placeholder"
        @navigate="emit('navigate')"
      >
        <template v-if="$slots.filters" #filters><slot name="filters" /></template>
        <template #actions><slot name="actions" /></template>
      </SearchPanel>

      <slot name="footer" />
    </SheetContent>
  </Sheet>
</template>
