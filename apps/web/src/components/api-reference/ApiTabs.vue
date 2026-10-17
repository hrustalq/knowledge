<script setup lang="ts">
/**
 * The tab strip of the API surfaces (#78): samples by language, a body's
 * Example and Schema, the request's Params · Headers · Body · Auth, the
 * response's Body and Headers. Hand-rolled, as every strip here is.
 *
 * One indicator travels between tabs instead of each tab drawing its own
 * underline, so a switch reads as the same marker moving rather than one going
 * out and another lighting up. It is positioned from the active tab's box after
 * mount; before that (and in the server render) the active tab carries a
 * static underline of its own, so nothing is unmarked while scripts load.
 *
 * Arrow keys, Home and End move the selection (roving tabindex). The panel is
 * the caller's: it takes `panelId(id)` / `tabId(id)` for its ARIA wiring.
 */
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

export interface ApiTab {
  id: string
  label: string
  /** A count beside the label, shown when above zero. */
  count?: number | null
  /** A dot beside the label: something in this tab is filled in. */
  dot?: boolean
}

const props = withDefaults(defineProps<{ tabs: ApiTab[]; label: string; size?: 'sm' | 'md' }>(), { size: 'md' })
const active = defineModel<string>({ required: true })
const uid = useId()
const list = ref<HTMLElement | null>(null)
const bar = ref<{ x: number; w: number } | null>(null)

const tabId = (id: string) => `${uid}-tab-${id}`
const panelId = (id: string) => `${uid}-panel-${id}`
defineExpose({ tabId, panelId })

function measure() {
  const el = list.value?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(active.value)}"]`)
  bar.value = el ? { x: el.offsetLeft, w: el.offsetWidth } : null
}

let observer: ResizeObserver | null = null
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && list.value) {
    observer = new ResizeObserver(measure)
    observer.observe(list.value)
  }
})
onBeforeUnmount(() => observer?.disconnect())
watch([active, () => props.tabs.map((t) => `${t.id}${t.count ?? ''}${t.dot ? '•' : ''}`).join()], () => nextTick(measure))

function onKeydown(event: KeyboardEvent) {
  const ids = props.tabs.map((t) => t.id)
  const from = ids.indexOf(active.value)
  const to =
    event.key === 'ArrowRight' ? (from + 1) % ids.length
    : event.key === 'ArrowLeft' ? (from - 1 + ids.length) % ids.length
    : event.key === 'Home' ? 0
    : event.key === 'End' ? ids.length - 1
    : -1
  if (to < 0) return
  event.preventDefault()
  active.value = ids[to]
  nextTick(() => document.getElementById(tabId(ids[to]))?.focus())
}
</script>

<template>
  <div class="relative min-w-0 border-b">
    <div
      ref="list"
      role="tablist"
      :aria-label="label"
      class="relative -mb-px flex min-w-0 overflow-x-auto [scrollbar-width:none]"
      @keydown="onKeydown"
    >
      <button
        v-for="tab in tabs"
        :id="tabId(tab.id)"
        :key="tab.id"
        type="button"
        role="tab"
        :data-tab="tab.id"
        :aria-selected="tab.id === active"
        :aria-controls="panelId(tab.id)"
        :tabindex="tab.id === active ? 0 : -1"
        class="kn-tab flex shrink-0 items-center gap-1.5 border-b-2 whitespace-nowrap transition-colors duration-150 outline-none focus-visible:rounded-t-sm focus-visible:ring-3 focus-visible:ring-ring/50"
        :class="[
          size === 'sm' ? 'px-2.5 pt-1 pb-1.5 text-[0.8rem]' : 'px-3 pt-1.5 pb-2 text-[0.85rem]',
          tab.id === active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
          tab.id === active && !bar ? 'border-primary' : 'border-transparent',
        ]"
        @click="active = tab.id"
      >
        {{ tab.label }}
        <span
          v-if="tab.count"
          class="grid h-[1.1rem] min-w-[1.1rem] place-items-center rounded-full px-1 text-[0.7rem] leading-none font-medium tabular-nums transition-colors duration-150"
          :class="tab.id === active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground'"
        >{{ tab.count }}</span>
        <span v-if="tab.dot" class="size-1.5 rounded-full bg-[color-mix(in_oklab,var(--kn-panel-tip)_80%,var(--foreground))]" aria-hidden="true" />
      </button>
      <span
        v-if="bar"
        class="kn-tab-bar pointer-events-none absolute bottom-0 left-0 h-0.5 rounded-full bg-primary"
        :style="{ transform: `translateX(${bar.x}px)`, width: `${bar.w}px` }"
        aria-hidden="true"
      />
    </div>
  </div>
</template>

<style scoped>
.kn-tab-bar {
  transition:
    transform var(--collapse-duration) var(--snap-ease),
    width var(--collapse-duration) var(--snap-ease);
}
@media (prefers-reduced-motion: reduce) {
  .kn-tab-bar {
    transition: none;
  }
}
</style>
