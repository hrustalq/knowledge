<script setup lang="ts" generic="K extends string">
/**
 * The one tab strip.
 *
 * The underline strips that used to be hand-rolled — `/settings/connectors`,
 * `/settings/security`, `/settings/access`, `/notifications`, the
 * merge-request detail, a project's site settings and the bot card — all draw
 * it here now. None of the copies was operable from a
 * keyboard: `role="tablist"` was present, but `aria-controls`, the matching
 * `role="tabpanel"` and arrow-key movement were not, so the same accessibility
 * defect shipped once per copy.
 *
 * What this adds on top of the incumbent look, which is otherwise unchanged:
 *
 * - **A roving tabindex.** Exactly one tab is in the tab order; Arrow keys move
 *   between them, Home and End jump to the ends. Without it every tab is its
 *   own tab stop, so reaching the content past a seven-tab strip costs seven
 *   presses.
 * - **Automatic activation** — moving focus selects. That is the WAI-ARIA
 *   default for tabs whose panels are already mounted lazily, and it is what
 *   the click behaviour here has always implied.
 * - **`aria-controls` pointing at a real panel.** The ids are derived in
 *   page-chrome.ts rather than passed in, so the strip and the panel cannot
 *   disagree about what the panel is called.
 *
 * Focus is moved only for keyboard-driven changes. A click has already put
 * focus where it belongs, and a programmatic change — restoring `?tab=` from a
 * link — must not yank focus out of whatever the reader was doing.
 */
import { nextTick } from 'vue'
import { panelId, tabId, type PageTab } from './page-chrome'

const props = defineProps<{
  modelValue: K
  tabs: readonly PageTab<K>[]
  /** Names the tablist for a screen reader — required, it is a landmark-ish role. */
  label: string
  /** Only for a strip that repeats on one page; see `tabId` in page-chrome.ts. */
  scope?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [K] }>()

function onKeydown(event: KeyboardEvent) {
  const total = props.tabs.length
  if (total === 0) return

  const from = props.tabs.findIndex((tab) => tab.key === props.modelValue)
  let to = from

  switch (event.key) {
    case 'ArrowLeft':
      to = (from - 1 + total) % total
      break
    case 'ArrowRight':
      to = (from + 1) % total
      break
    case 'Home':
      to = 0
      break
    case 'End':
      to = total - 1
      break
    default:
      return
  }

  // Only now: an unhandled key must keep its default, or typing in a field that
  // happens to sit inside the strip would stop working.
  event.preventDefault()
  const key = props.tabs[to].key
  emit('update:modelValue', key)
  void nextTick(() => document.getElementById(tabId(key, props.scope))?.focus())
}
</script>

<template>
  <div
    role="tablist"
    :aria-label="label"
    class="kn-scroll-strip flex gap-0.5 overflow-x-auto border-b"
    @keydown="onKeydown"
  >
    <button
      v-for="tab in tabs"
      :id="tabId(tab.key, scope)"
      :key="tab.key"
      type="button"
      role="tab"
      :aria-selected="modelValue === tab.key"
      :aria-controls="panelId(tab.key, scope)"
      :tabindex="modelValue === tab.key ? 0 : -1"
      class="flex shrink-0 items-center gap-1.5 rounded-t-sm border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
      :class="
        modelValue === tab.key
          ? 'border-primary font-medium text-primary'
          : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
      "
      @click="emit('update:modelValue', tab.key)"
    >
      <component :is="tab.icon" v-if="tab.icon" class="size-3.5 shrink-0" aria-hidden="true" />
      {{ tab.label }}
      <!-- `null` is "not loaded yet" and draws nothing; 0 is a fact worth
           showing, so it is not folded into falsiness. The count belongs to
           the tab, so it takes the tab's state rather than staying grey next
           to an active label. -->
      <span
        v-if="tab.count !== null && tab.count !== undefined"
        class="rounded-full px-1.5 text-xs tabular-nums"
        :class="modelValue === tab.key ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'"
      >
        {{ tab.count }}
      </span>
    </button>
  </div>
</template>
