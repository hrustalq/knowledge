<script setup lang="ts">
/**
 * Filter autocomplete: a debounced input with an inline result list.
 *
 * The list renders inline rather than in a floating popover on purpose — this
 * is used inside the search sheet's dialog, and a portalled popper fights the
 * dialog focus trap. Inline also keeps the rail's scroll behaviour predictable.
 *
 * Options can be static (`options`) or loaded per keystroke (`load`), so the
 * same control backs both the bounded lists (workspace, category, project) and
 * the unbounded one (tags, which are searched server-side).
 */
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import { refDebounced, useElementBounding, useVirtualList, useWindowSize } from '@vueuse/core'
import { Check, Loader2, Search, X } from 'lucide-vue-next'

export interface AutocompleteOption {
  /** Stable identity — what selection is stored as. */
  value: string
  label: string
  /** Muted trailing metadata, e.g. a usage count. */
  meta?: string | number
}

const props = withDefaults(
  defineProps<{
    /** Selected values. Single-select carries 0 or 1 entry. */
    modelValue: string[]
    label: string
    placeholder?: string
    multiple?: boolean
    /** Static options, filtered client-side. */
    options?: AutocompleteOption[]
    /** Async loader; receives the debounced query. Takes precedence over `options`. */
    load?: (query: string) => Promise<AutocompleteOption[]>
    /** Shown when there is nothing to pick at all (not merely no match). */
    emptyHint?: string
    /**
     * Last-resort display for a selected value whose option was never loaded —
     * e.g. after a reload restores `tag:auth` before the roster is fetched.
     */
    fallbackLabel?: (value: string) => string
    disabled?: boolean
  }>(),
  { multiple: true, placeholder: 'Search…' },
)

const emit = defineEmits<{ 'update:modelValue': [string[]] }>()

const query = ref('')
const debouncedQuery = refDebounced(query, 200)
const open = ref(false)
const loading = ref(false)
const loaded = ref<AutocompleteOption[]>([])
const activeIndex = ref(0)
const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

let seq = 0

/** Async mode fetches; static mode filters locally. */
watch(
  [debouncedQuery, open],
  async ([q, isOpen]) => {
    if (!props.load || !isOpen) return
    const ticket = ++seq
    loading.value = true
    try {
      const res = await props.load(q)
      if (ticket === seq) loaded.value = res
    } catch {
      if (ticket === seq) loaded.value = []
    } finally {
      if (ticket === seq) loading.value = false
    }
  },
  { immediate: true },
)

const source = computed(() => (props.load ? loaded.value : (props.options ?? [])))

const matches = computed(() => {
  if (props.load) return source.value
  const needle = query.value.trim().toLowerCase()
  if (!needle) return source.value
  return source.value.filter((o) => o.label.toLowerCase().includes(needle))
})

/**
 * Labels seen so far, so a chip keeps its human name after the option list has
 * moved on — async options are only loaded while the list is open, so without
 * this a tag chip degrades to its raw key ("tag:auth" instead of "auth").
 */
const labelCache = new Map<string, string>()
watch(
  source,
  (options) => {
    for (const o of options) labelCache.set(o.value, o.label)
  },
  { immediate: true },
)

const selectedOptions = computed(() =>
  props.modelValue.map((v) => {
    const known = source.value.find((o) => o.value === v)
    if (known) return known
    const cached = labelCache.get(v)
    return { value: v, label: cached ?? props.fallbackLabel?.(v) ?? v }
  }),
)

const isEmptyRoster = computed(
  () => !props.load && (props.options?.length ?? 0) === 0,
)

/**
 * Single-select wears its choice in the field: it has no chips (those would
 * read as "one of several" for a control that holds exactly one), so the field
 * is the only place the selection can show. While the list is open the query
 * wins, so typing always starts from a clean field rather than from a label
 * the user has to delete first.
 */
const selectedLabel = computed(() =>
  props.multiple ? '' : (selectedOptions.value[0]?.label ?? ''),
)
const displayValue = computed(() =>
  open.value ? query.value : selectedLabel.value || query.value,
)

watch(matches, () => {
  activeIndex.value = 0
})

function isSelected(value: string) {
  return props.modelValue.includes(value)
}

function pick(option: AutocompleteOption) {
  if (props.multiple) {
    const next = isSelected(option.value)
      ? props.modelValue.filter((v) => v !== option.value)
      : [...props.modelValue, option.value]
    emit('update:modelValue', next)
    query.value = ''
    // Stay open so several can be picked in a row. Re-asserting `open` matters
    // because a stray blur during the press would otherwise have closed it.
    void nextTick(() => {
      inputEl.value?.focus()
      open.value = true
    })
  } else {
    emit('update:modelValue', [option.value])
    query.value = ''
    open.value = false
    inputEl.value?.blur()
  }
}

function remove(value: string) {
  emit('update:modelValue', props.modelValue.filter((v) => v !== value))
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    // Only dismiss the list. Without this the same Escape keeps bubbling to an
    // enclosing dialog (the search sheet) and closes that too.
    if (open.value) e.stopPropagation()
    open.value = false
    inputEl.value?.blur()
    return
  }
  if (e.key === 'Backspace' && !query.value && props.modelValue.length > 0) {
    remove(props.modelValue[props.modelValue.length - 1]!)
    return
  }
  if (!open.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, matches.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const option = matches.value[activeIndex.value]
    if (option) pick(option)
  }
}

/**
 * Opening a single-select drops the displayed label so the whole roster is
 * offered; leaving the field brings the selection back (see `displayValue`).
 */
function onFocus() {
  if (!props.multiple) query.value = ''
  open.value = true
}

/** Blur closes, but not when the click landed inside our own list. */
function onBlur(e: FocusEvent) {
  const next = e.relatedTarget as Node | null
  if (next && rootEl.value?.contains(next)) return
  open.value = false
}

/**
 * The list is teleported to <body> and fixed-positioned against the field.
 * Rendering it in flow pushed the rest of the rail down on every open, and a
 * plain absolute list would be clipped by the rail's own overflow-y-auto.
 * useElementBounding re-measures on scroll and resize, so the panel tracks the
 * field instead of drifting away from it.
 */
const fieldEl = ref<HTMLElement | null>(null)
const bounds = useElementBounding(fieldEl)
const { height: viewportHeight } = useWindowSize()

/**
 * Re-measure every time the list opens. useElementBounding tracks scroll and
 * resize, but not transforms — and this lives inside a sheet that slides in
 * from the right, so bounds captured at mount put the list where the panel
 * *started*, far from the field. rAF covers opening mid-animation.
 */
watch(open, (isOpen) => {
  if (!isOpen) return
  bounds.update()
  void nextTick(() => bounds.update())
  requestAnimationFrame(() => bounds.update())
  // The sheet's slide runs 200ms; catch the settled position too.
  setTimeout(() => bounds.update(), 240)
})

const MAX_LIST_HEIGHT = 224
const GAP = 4

/** Flip above the field when there is not enough room beneath it. */
const dropUp = computed(
  () =>
    bounds.bottom.value + GAP + MAX_LIST_HEIGHT > viewportHeight.value &&
    bounds.top.value > viewportHeight.value - bounds.bottom.value,
)

const listStyle = computed(() => ({
  position: 'fixed' as const,
  left: `${bounds.left.value}px`,
  width: `${bounds.width.value}px`,
  ...(dropUp.value
    ? { bottom: `${viewportHeight.value - bounds.top.value + GAP}px` }
    : { top: `${bounds.bottom.value + GAP}px` }),
}))

/** Applied to the scroll container, not the box, so the virtual list can size itself. */
const listMaxHeight = computed(
  () =>
    `${Math.min(
      MAX_LIST_HEIGHT,
      Math.max(
        120,
        dropUp.value
          ? bounds.top.value - GAP
          : viewportHeight.value - bounds.bottom.value - GAP * 2,
      ),
    )}px`,
)

/**
 * Teleport is client-only. This app is server-rendered, and a <Teleport> in the
 * SSR pass emits its content into a buffer that entry-server never splices into
 * the HTML — the anchors then fail to hydrate and take the whole page down
 * (/search rendered blank). Nothing is teleported until after mount, so server
 * and first client render agree.
 */
const mounted = ref(false)
onMounted(() => {
  mounted.value = true
})

// useId, not Math.random: the id is rendered during SSR, so a random one
// differs between server and client and trips a hydration mismatch.
/**
 * Virtualized rows: a workspace can carry hundreds of tags, and rendering the
 * whole roster on every keystroke is wasted work. ITEM_HEIGHT must match the
 * row's rendered height (h-7) or the scroll offset drifts.
 */
const ITEM_HEIGHT = 28
const {
  list: virtualRows,
  containerProps,
  wrapperProps,
  scrollTo,
} = useVirtualList(matches, { itemHeight: ITEM_HEIGHT, overscan: 8 })

/** Keep the keyboard cursor on screen — the active row may not be rendered. */
watch(activeIndex, (i) => {
  if (open.value && matches.value.length > 0) scrollTo(i)
})

const listId = useId()
</script>

<template>
  <div ref="rootEl" class="space-y-1.5">
    <label
      :for="listId + '-input'"
      class="block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
    >
      {{ label }}
    </label>

    <div ref="fieldEl" class="relative">
      <Search
        class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
      />
      <input
        :id="listId + '-input'"
        ref="inputEl"
        :value="displayValue"
        type="text"
        role="combobox"
        autocomplete="off"
        :aria-expanded="open"
        :aria-controls="listId"
        :placeholder="placeholder"
        :disabled="disabled || isEmptyRoster"
        class="h-8 w-full rounded-md border bg-background pl-8 pr-7 text-xs outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50"
        @input="query = ($event.target as HTMLInputElement).value"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <Loader2
        v-if="loading"
        class="absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
      />
    </div>

    <!-- Teleported and fixed: opening must not reflow the rail, and the rail's
         own overflow must not clip the list. -->
    <Teleport v-if="mounted" to="body">
      <!--
        Two guards, both because this list is teleported outside any enclosing
        dialog:
        - pointer-events-auto: an open reka-ui dialog sets `pointer-events:none`
          on <body>, so without it every click falls through to what's beneath.
        - @pointerdown.stop: reka-ui's DismissableLayer listens for pointerdown
          on the document to detect an "outside" press, so a click in here would
          otherwise dismiss the sheet. Containing it also covers scrollbar drags.
      -->
      <div
        v-if="open && !isEmptyRoster"
        :style="listStyle"
        @pointerdown.stop
        class="animate-in fade-in-0 pointer-events-auto z-[60] overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md duration-100"
      >
        <!-- Vertical padding lives on the box, never on the scroll container:
             useVirtualList maps scrollTop straight onto item offsets, so any
             padding-top/bottom here desynchronises the rows from the scrollbar. -->
        <div
          v-show="matches.length > 0"
          v-bind="containerProps"
          :style="[containerProps.style, { maxHeight: listMaxHeight }]"
          class="px-1"
        >
          <ul :id="listId" role="listbox" v-bind="wrapperProps">
            <li
              v-for="row in virtualRows"
              :key="row.data.value"
              role="option"
              :aria-selected="isSelected(row.data.value)"
              class="flex h-7 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-xs transition-colors"
              :class="
                row.index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
              "
              @mouseenter="activeIndex = row.index"
              @mousedown.prevent="pick(row.data)"
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <Check
                  class="size-3 shrink-0"
                  :class="isSelected(row.data.value) ? 'text-primary' : 'invisible'"
                />
                <span class="truncate">{{ row.data.label }}</span>
              </span>
              <span
                v-if="row.data.meta !== undefined"
                class="shrink-0 tabular-nums text-muted-foreground"
              >
                {{ row.data.meta }}
              </span>
            </li>
          </ul>
        </div>

        <p v-if="matches.length === 0 && !loading" class="px-3 py-1.5 text-xs text-muted-foreground">
          No match for “{{ query }}”.
        </p>
      </div>
    </Teleport>

    <p v-if="isEmptyRoster && emptyHint" class="text-[11px] leading-snug text-muted-foreground">
      {{ emptyHint }}
    </p>

    <!-- Selections persist below the field, so they stay visible once the list closes. -->
    <div v-if="selectedOptions.length > 0 && multiple" class="flex flex-wrap gap-1 pt-0.5">
      <span
        v-for="o in selectedOptions"
        :key="o.value"
        class="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary"
      >
        {{ o.label }}
        <button
          type="button"
          class="rounded-full p-0.5 transition-colors hover:bg-primary/20"
          :aria-label="`Remove ${o.label}`"
          @click="remove(o.value)"
        >
          <X class="size-3" />
        </button>
      </span>
    </div>
  </div>
</template>
