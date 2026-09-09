<script setup lang="ts">
/**
 * Single-select combobox: a resting trigger that shows the *current* selection,
 * and a popover carrying a filter input, the roster, and one pinned action row.
 *
 * Sibling to (not a replacement for) `ui/autocomplete`, which is a multi-select
 * *filter field* built for the search sheet: it renders its list inline and has
 * no resting value, because a filter has nothing to display until you type. A
 * switcher is the inverse — it must read as "you are in Demo Workspace" while
 * closed, so the value lives in the trigger and the input only exists once the
 * list is open.
 *
 * The footer action sits outside `ComboboxViewport` on purpose: inside it, it
 * would be treated as a roster row — filtered away by the search term and
 * reachable by the arrow keys, which is exactly wrong for "create a new one".
 *
 * The popover is deliberately wider than its anchor: the navigation rail is
 * 256px, and a list that inherits that width truncates names the trigger
 * itself renders in full.
 */
import { nextTick, ref, watch } from 'vue'
import {
  ComboboxAnchor,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxRoot,
  ComboboxViewport,
} from 'reka-ui'
import { Check, Plus, Search } from 'lucide-vue-next'
import { cn } from '@/lib/utils'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

export interface ComboboxOption {
  /** Stable identity; what `modelValue` carries. */
  value: string
  label: string
  /** Muted trailing metadata — a real count, not decoration. */
  meta?: string
  disabled?: boolean
}

const props = withDefaults(
  defineProps<{
    modelValue: string | null
    options: ComboboxOption[]
    /** Names the roster for assistive tech and the empty state. */
    label: string
    searchPlaceholder?: string
    /** Label for the pinned footer action. Omitted = no footer. */
    createLabel?: string
    disabled?: boolean
    align?: 'start' | 'center' | 'end'
    contentClass?: string
  }>(),
  { align: 'start' },
)

const emit = defineEmits<{
  'update:modelValue': [string]
  /** Carries the typed query so the create form can pre-fill the name. */
  create: [query: string]
}>()

const open = ref(false)
const search = ref('')

// Search term resets are handled here rather than by reka's own
// `resetSearchTermOn*`: those write the *model value* back into the input,
// which for a string model means the raw id briefly appears in the field.
watch(open, (isOpen) => {
  if (!isOpen) search.value = ''
})

function select(value: string) {
  open.value = false
  emit('update:modelValue', value)
}

function requestCreate() {
  const query = search.value.trim()
  open.value = false
  // Let the popover finish unmounting before the dialog claims focus,
  // otherwise the two focus traps hand off mid-teardown and the form's
  // first field never receives focus.
  void nextTick(() => emit('create', query))
}
</script>

<template>
  <ComboboxRoot
    :model-value="modelValue ?? undefined"
    v-model:open="open"
    :disabled="disabled"
    :reset-search-term-on-blur="false"
    :reset-search-term-on-select="false"
    @update:model-value="(v) => typeof v === 'string' && select(v)"
  >
    <ComboboxAnchor as-child>
      <button
        type="button"
        :disabled="disabled"
        :aria-label="label"
        aria-haspopup="listbox"
        :aria-expanded="open"
        class="group/trigger w-full text-left outline-none disabled:pointer-events-none disabled:opacity-50"
        @click="open = !open"
      >
        <slot name="trigger" :open="open" />
      </button>
    </ComboboxAnchor>

    <ComboboxContent
      position="popper"
      :align="align"
      :side-offset="6"
      :class="cn(
        'bg-popover text-popover-foreground z-50 flex max-h-[min(22rem,var(--reka-popper-available-height))] w-[280px] max-w-[calc(100vw-2rem)] min-w-[var(--reka-combobox-trigger-width)] flex-col overflow-hidden rounded-lg border shadow-[0_12px_32px_-8px] shadow-foreground/15 dark:shadow-black/60',
        'origin-[var(--reka-combobox-content-transform-origin)] duration-150 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
        contentClass,
      )"
    >
      <div class="border-border/70 relative shrink-0 border-b">
        <Search
          class="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2"
        />
        <ComboboxInput
          v-model="search"
          auto-focus
          :placeholder="searchPlaceholder ?? t('common.searchIn', { label: label.toLowerCase() })"
          class="placeholder:text-muted-foreground h-9 w-full bg-transparent pr-3 pl-9 text-[13px] outline-none"
        />
      </div>

      <ComboboxViewport class="quiet-scroll min-h-0 flex-1 overflow-y-auto p-1">
        <ComboboxEmpty class="text-muted-foreground px-3 py-6 text-center text-xs">
          <template v-if="options.length === 0">{{ t('common.noneYet', { label: label.toLowerCase() }) }}</template>
          <template v-else>
            <i18n-t keypath="common.noMatchFor" tag="span" scope="global">
              <template #query><span class="text-foreground font-medium">“{{ search }}”</span></template>
            </i18n-t>
          </template>
        </ComboboxEmpty>

        <ComboboxItem
          v-for="option in options"
          :key="option.value"
          :value="option.value"
          :text-value="option.label"
          :disabled="option.disabled"
          class="text-sidebar-foreground data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-[state=checked]:text-primary group/item flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] outline-none select-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[state=checked]:font-medium"
        >
          <slot name="option" :option="option">
            <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          </slot>
          <span
            v-if="option.meta"
            class="text-muted-foreground group-data-[highlighted]/item:text-accent-foreground/70 shrink-0 text-[11px] tabular-nums"
          >{{ option.meta }}</span>
          <ComboboxItemIndicator class="shrink-0">
            <Check class="size-3.5" />
          </ComboboxItemIndicator>
        </ComboboxItem>
      </ComboboxViewport>

      <div v-if="createLabel" class="border-border/70 shrink-0 border-t p-1">
        <button
          type="button"
          class="text-muted-foreground hover:bg-accent hover:text-primary focus-visible:bg-accent focus-visible:text-primary group/create flex h-8 w-full items-center gap-2 rounded-md px-2 text-[13px] transition-colors outline-none"
          @click="requestCreate"
        >
          <span
            class="border-border group-hover/create:border-primary group-focus-visible/create:border-primary grid size-4 shrink-0 place-items-center rounded-[5px] border border-dashed transition-colors"
          >
            <Plus class="size-3" />
          </span>
          {{ createLabel }}
        </button>
      </div>
    </ComboboxContent>
  </ComboboxRoot>
</template>
