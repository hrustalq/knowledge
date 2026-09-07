<script setup lang="ts">
/**
 * The one searchable list the filter bar opens — for picking a field, and for
 * picking a field's values. Both are "search a short roster and choose", so
 * they share this rather than growing two near-identical popovers.
 *
 * Grouping is derived from the items themselves (first-seen order, ungrouped
 * first) so callers order a flat array instead of nesting one.
 */
import { computed, ref, watch } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxLabel,
  ComboboxRoot,
  ComboboxSeparator,
  ComboboxViewport,
} from 'reka-ui'
import { Check, Search } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import type { FilterOption } from './types'

const props = withDefaults(
  defineProps<{
    items: (FilterOption & { group?: string })[]
    /** Multi-select keeps the popover open and shows tick marks. */
    multiple?: boolean
    /** Selected values; only meaningful when `multiple`. */
    modelValue?: string[]
    searchPlaceholder?: string
    emptyLabel?: string
    align?: 'start' | 'center' | 'end'
  }>(),
  { modelValue: () => [], align: 'start', emptyLabel: 'No matches' },
)

const emit = defineEmits<{
  'update:modelValue': [string[]]
  /** Single-select choice; fires once and closes. */
  'select': [value: string]
}>()

const open = ref(false)
const search = ref('')

watch(open, (isOpen) => {
  if (!isOpen) search.value = ''
})

/** [groupLabel, items][] — '' is the leading ungrouped section. */
const sections = computed(() => {
  const bucket = new Map<string, FilterOption[]>()
  for (const item of props.items) {
    const key = item.group ?? ''
    const list = bucket.get(key)
    if (list) list.push(item)
    else bucket.set(key, [item])
  }
  // Ungrouped leads regardless of where it appeared in the source array.
  return [...bucket.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : 0))
})

function onModel(value: unknown) {
  if (props.multiple) {
    emit('update:modelValue', (value as string[]) ?? [])
    return
  }
  if (typeof value !== 'string') return
  open.value = false
  emit('select', value)
}

defineExpose({ openMenu: () => (open.value = true) })
</script>

<template>
  <ComboboxRoot
    v-model:open="open"
    :model-value="multiple ? modelValue : undefined"
    :multiple="multiple"
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    @update:model-value="onModel"
  >
    <ComboboxAnchor as-child>
      <slot name="trigger" :open="open" :toggle="() => (open = !open)" />
    </ComboboxAnchor>

    <ComboboxContent
      position="popper"
      :align="align"
      :side-offset="6"
      :class="cn(
        'bg-popover text-popover-foreground z-50 flex max-h-[min(22rem,var(--reka-popper-available-height))] w-[240px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg border shadow-[0_12px_32px_-8px] shadow-foreground/15 dark:shadow-black/60',
        'origin-[var(--reka-combobox-content-transform-origin)] duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
      )"
    >
      <div class="border-border/70 relative shrink-0 border-b">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
        />
        <ComboboxInput
          v-model="search"
          auto-focus
          :placeholder="searchPlaceholder ?? 'Filter…'"
          class="placeholder:text-muted-foreground h-9 w-full bg-transparent pr-3 pl-9 text-[13px] outline-none"
        />
      </div>

      <ComboboxViewport class="quiet-scroll min-h-0 flex-1 overflow-y-auto p-1">
        <ComboboxEmpty class="text-muted-foreground px-3 py-6 text-center text-xs">
          {{ emptyLabel }}
        </ComboboxEmpty>

        <template v-for="([group, groupItems], i) in sections" :key="group || '_'">
          <ComboboxSeparator v-if="i > 0" class="bg-border/70 my-1 h-px" />
          <ComboboxGroup>
            <ComboboxLabel
              v-if="group"
              class="text-muted-foreground px-2 pt-1.5 pb-1 text-[11px] font-semibold tracking-wider uppercase"
            >
              {{ group }}
            </ComboboxLabel>
            <ComboboxItem
              v-for="item in groupItems"
              :key="item.value"
              :value="item.value"
              :text-value="item.label"
              class="data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground group/item flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none"
            >
              <component :is="item.icon" v-if="item.icon" class="text-muted-foreground size-3.5 shrink-0" />
              <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
              <span
                v-if="item.meta !== undefined"
                class="text-muted-foreground shrink-0 text-[11px] tabular-nums"
              >{{ item.meta }}</span>
              <ComboboxItemIndicator class="shrink-0">
                <Check class="size-3.5" />
              </ComboboxItemIndicator>
            </ComboboxItem>
          </ComboboxGroup>
        </template>
      </ComboboxViewport>
    </ComboboxContent>
  </ComboboxRoot>
</template>
