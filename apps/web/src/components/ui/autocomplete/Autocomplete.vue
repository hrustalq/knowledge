<script setup lang="ts">
/**
 * Filter autocomplete: a debounced input with an inline result list.
 *
 * The list renders inline rather than in a floating popover on purpose — this
 * is used inside the search sheet's dialog, and a portalled popper fights the
 * dialog focus trap. Inline also keeps the rail's scroll behavior predictable.
 *
 * Options can be static (`options`) or loaded per keystroke (`load`), so the
 * same control backs both the bounded lists (workspace, category, project) and
 * the unbounded one (tags, which are searched server-side).
 */
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { refDebounced, useVirtualList } from '@vueuse/core'
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/vue'
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
    /**
     * Shortest query worth sending upstream. 0 (the default) searches from the
     * first keystroke, which is right for a bounded roster.
     *
     * Set it where each query is a fan-out over a remote API: one or two
     * characters match most of a corpus, so the request is both expensive and
     * useless. An empty query is always allowed through — that is "show me the
     * first page", not a search — and only 1..min-1 is held back.
     */
    minQueryLength?: number
    /** Shown when there is nothing to pick at all (not merely no match). */
    emptyHint?: string
    /**
     * Last-resort display for a selected value whose option was never loaded —
     * e.g. after a reload restores `tag:auth` before the roster is fetched.
     */
    fallbackLabel?: (value: string) => string
    disabled?: boolean
    /**
     * Keep the label for screen readers but drop it visually — for toolbar
     * rows, where a stacked caption would break the line the field sits on.
     */
    hideLabel?: boolean
    /**
     * Render as a naked input — no border, background, ring or search glyph —
     * for use inside a container that already looks like a field (the merge
     * request filtered-search bar, where chips and this input share one box).
     */
    bare?: boolean
    /**
     * The typed text, when the caller wants to drive it too (`v-model:query`).
     * Needed so an external reset — a "clear filters" button elsewhere on the
     * page — actually empties the field instead of leaving stale text behind
     * while the results it no longer describes come back.
     */
    query?: string
  }>(),
  { multiple: true, placeholder: 'Search…' },
)

const emit = defineEmits<{
  'update:modelValue': [string[]]
  /**
   * The typed text, as it changes. Lets a caller use the field as a search box
   * *and* a picker: the query narrows a list while the options offer something
   * else entirely. Picking clears the query, which reads correctly — the text
   * was how you found the option, not a filter in its own right.
   */
  'update:query': [string]
}>()

const query = ref(props.query ?? '')
watch(query, (q) => emit('update:query', q))
watch(
  () => props.query,
  (q) => {
    if (q !== undefined && q !== query.value) query.value = q
  },
)
const debouncedQuery = refDebounced(query, 200)
const open = ref(false)
const loading = ref(false)
const loaded = ref<AutocompleteOption[]>([])
const activeIndex = ref(0)
const rootEl = ref<HTMLElement | null>(null)
const inputEl = ref<HTMLInputElement | null>(null)

const { t } = useI18n()

/**
 * A query too short to send, as opposed to no query at all. Drives both the
 * skipped fetch and the message, so the two cannot disagree.
 */
const belowMin = computed(() => {
  const n = props.minQueryLength ?? 0
  const len = query.value.trim().length
  return n > 0 && len > 0 && len < n
})

let seq = 0

/** Async mode fetches; static mode filters locally. */
watch(
  [debouncedQuery, open],
  async ([q, isOpen]) => {
    if (!props.load || !isOpen) return
    // Below the threshold the previous results are cleared rather than left
    // standing: showing the last query's matches under a newer query is a
    // worse lie than showing nothing.
    if (belowMin.value) {
      loaded.value = []
      loading.value = false
      return
    }
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

/**
 * Nothing to pick *at all*, as opposed to nothing matching this query.
 *
 * Previously `!props.load && ...`, which made it unreachable for an async
 * control — so a loader that legitimately returned nothing fell through to
 * "no match for X" and blamed the query for an empty roster. In async mode the
 * roster is empty when an unfiltered load came back with nothing.
 */
const isEmptyRoster = computed(() =>
  props.load
    ? !loading.value && query.value.trim() === '' && loaded.value.length === 0
    : (props.options?.length ?? 0) === 0,
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
  // New results start at the top. The activeIndex watcher cannot do this: it
  // only fires when the index actually changes, and it usually was 0 already.
  scrollTo(0)
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
    ensureVisible(activeIndex.value)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
    ensureVisible(activeIndex.value)
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
 * The list is teleported to <body> and positioned by Floating UI against the
 * field. Rendering it in flow pushed the rest of the rail down on every open,
 * and a plain absolute list would be clipped by the rail's own overflow-y-auto.
 *
 * `flip` picks above/below, `shift` keeps it on screen horizontally, and `size`
 * reports the room actually left so the scroller can cap itself — replacing
 * three hand-written computeds that did the same arithmetic by hand.
 *
 * `animationFrame` is deliberate: this lives inside a Sheet that slides in on a
 * CSS transform, and neither scroll nor resize observers fire during that. The
 * old code chased it with a nextTick, a rAF and a 240ms timeout; tracking each
 * frame while the list is open is both correct and cheaper to reason about.
 */
const fieldEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)

const MAX_LIST_HEIGHT = 224
const GAP = 4

const available = ref(MAX_LIST_HEIGHT)

const { floatingStyles, placement } = useFloating(fieldEl, listEl, {
  placement: 'bottom-start',
  strategy: 'fixed',
  whileElementsMounted: (reference, floating, update) =>
    autoUpdate(reference, floating, update, { animationFrame: true }),
  middleware: [
    offset(GAP),
    flip({ padding: GAP * 2 }),
    shift({ padding: GAP * 2 }),
    size({
      padding: GAP * 2,
      apply({ availableHeight, rects, elements }) {
        available.value = availableHeight
        // Match the field's width, as a dropdown should.
        elements.floating.style.width = `${rects.reference.width}px`
      },
    }),
  ],
})

/**
 * The side Floating UI actually resolved to — `flip` puts the list above the
 * field near the bottom of the viewport, and a list that grows downward while
 * hanging upward reads as a different control. Drives the entrance's origin
 * and its 4px of travel, both in CSS.
 */
const side = computed(() => (placement.value.startsWith('top') ? 'top' : 'bottom'))

/** Applied to the scroll container, not the box, so the virtual list can size itself. */
const listMaxHeight = computed(
  () => `${Math.min(MAX_LIST_HEIGHT, Math.max(120, available.value - GAP * 2))}px`,
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

/**
 * Keep the *keyboard* cursor on screen — and only the keyboard one.
 *
 * This deliberately is not a watcher on `activeIndex`. The pointer sets that
 * index too, and scrolling in response to the pointer is a feedback loop:
 * scrolling moves a different row under a stationary cursor, which sets the
 * index again, which scrolls again — the list runs away downwards and cannot
 * be scrolled back up.
 *
 * It also scrolls by the minimum needed rather than pinning the row to the top,
 * so arrowing onto a row that is already visible does not jerk the list.
 */
function ensureVisible(index: number) {
  const el = containerProps.ref.value
  if (!el) {
    scrollTo(index)
    return
  }
  const top = index * ITEM_HEIGHT
  const bottom = top + ITEM_HEIGHT
  if (top < el.scrollTop) el.scrollTop = top
  else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
}

const listId = useId()
</script>

<template>
  <div ref="rootEl" :class="hideLabel ? '' : 'space-y-1.5'">
    <label
      :for="listId + '-input'"
      :class="hideLabel
        ? 'sr-only'
        : 'block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground'"
    >
      {{ label }}
    </label>

    <div ref="fieldEl" class="relative">
      <Search
        v-if="!bare"
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
        :disabled="disabled || (!load && isEmptyRoster)"
        :class="bare
          ? 'h-6 w-full bg-transparent pr-6 text-xs outline-none placeholder:text-muted-foreground disabled:opacity-50'
          : 'h-8 w-full rounded-md border bg-background pl-8 pr-7 text-xs outline-none transition-colors focus:border-ring focus:ring-3 focus:ring-ring/50 disabled:opacity-50'"
        @input="query = ($event.target as HTMLInputElement).value"
        @focus="onFocus"
        @blur="onBlur"
        @keydown="onKeydown"
      />
      <Loader2
        v-if="loading"
        class="absolute top-1/2 size-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
        :class="bare ? 'right-0' : 'right-2.5'"
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
        - @pointerdown.stop: reka-ui's DismissibleLayer listens for pointerdown
          on the document to detect an "outside" press, so a click in here would
          otherwise dismiss the sheet. Containing it also covers scrollbar drags.
      -->
      <Transition name="kn-pop">
        <!--
          Two elements, and the split is load-bearing. Floating UI positions
          with a `transform`, and tw-animate-css's `animate-in` writes
          `transform` in its own keyframe — on one element the keyframe wins,
          so the list interpolated *from* an untranslated `translate3d(0,0,0)`.
          With `position:fixed; left:0; top:0` that is the top-left corner of
          the window, and the list flew diagonally across the screen to reach
          its field. It looked right on a phone only because the corner and the
          field are a few pixels apart there.

          So: the outer element is a positioner and owns nothing but Floating
          UI's transform. The inner surface carries the border, the ground and
          the motion, and grows out of whichever edge the list actually hangs
          off (`data-side`, which `flip` can change).
        -->
        <div
          v-if="open && !isEmptyRoster"
          ref="listEl"
          :style="floatingStyles"
          :data-side="side"
          @pointerdown.stop
          class="kn-pop pointer-events-auto z-60"
        >
          <div
            class="kn-pop-surface overflow-hidden rounded-md border bg-popover py-1 text-popover-foreground shadow-md"
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
                <!-- Hover uses mousemove, not mouseenter: mouseenter also fires
                     when the list scrolls under a stationary cursor, which would
                     hand the keyboard cursor back to whichever row slid under the
                     pointer (and, with a scroll-on-activate watcher, ran away). -->
                <li
                  v-for="row in virtualRows"
                  :key="row.data.value"
                  role="option"
                  :aria-selected="isSelected(row.data.value)"
                  class="flex h-7 cursor-pointer items-center justify-between gap-2 rounded-sm px-2 text-xs transition-colors"
                  :class="
                    row.index === activeIndex ? 'bg-accent text-accent-foreground' : 'hover:bg-muted'
                  "
                  @mousemove="activeIndex = row.index"
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

            <p
              v-if="matches.length === 0 && !loading"
              class="px-3 py-1.5 text-xs text-muted-foreground"
            >
              <template v-if="belowMin">
                {{ t('common.typeAtLeast', { n: props.minQueryLength }) }}
              </template>
              <template v-else-if="isEmptyRoster && emptyHint">{{ emptyHint }}</template>
              <template v-else-if="query.trim() !== ''">
                {{ t('common.noMatchFor', { query: `“${query}”` }) }}
              </template>
              <template v-else>{{ emptyHint ?? t('common.none') }}</template>
            </p>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- Static mode only. An async control says the same thing inside its open
         list, and rendering both would print the hint twice. -->
    <p v-if="!load && isEmptyRoster && emptyHint" class="text-[11px] leading-snug text-muted-foreground">
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
