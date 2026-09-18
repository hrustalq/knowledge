<script setup lang="ts" generic="K extends string">
/**
 * The page rail: a stack of collapsible widgets holding everything *about* the
 * subject rather than *in* it.
 *
 * The shape is feature 15's and unchanged — `RailSection` still draws each row,
 * still shows the one fact that decides whether to open it, still mounts its
 * body only while open. What moves here is the part both the document page and
 * the project page had written out separately: the open set, the `?tab=`
 * opening instruction, and the grid the rail sits in.
 *
 * Two things are better for the move.
 *
 * **The rail remembers.** Open state lives in the layout store keyed by
 * surface, so a reader who always checks History finds it open on the next page
 * instead of opening it again on every one. Session-scoped, not persisted — see
 * stores/layout.ts for why a remembered set restored after hydration would push
 * the page down under the reader.
 *
 * **`?tab=` applies on arrival and then lets go.** It was already an *opening*
 * instruction rather than two-way state (several widgets can be open at once,
 * which a single query value cannot describe), but reading it from a live
 * computed would re-open a widget the moment the reader closed it. It is
 * applied once at setup and again only when the query itself changes, which is
 * what makes a deep link work when you are already on a sibling page.
 *
 * Maximizing stays with the page. Two callers need two different frames — the
 * document's graph goes to the lightbox while its revision table goes to a
 * scrolling dialog — so this emits which widget was asked for and renders no
 * frame of its own. A rail that owned the dialog would have to be told about
 * every exception, which is the page's knowledge, not the rail's.
 */
import { computed, watch } from 'vue'
import { useRoute } from 'vue-router'
import RailSection from '@/components/knowledge/RailSection.vue'
import { useLayoutStore } from '@/stores/layout'
import type { RailWidget } from './page-chrome'

const props = withDefaults(
  defineProps<{
    widgets: readonly RailWidget<K>[]
    /**
     * Which rail this is, for the remembered open set. Keyed rather than global
     * because the vocabularies do not overlap — a project rail has no
     * `revisions`, and one shared set would carry ids into a rail that has no
     * such widget.
     */
    surface: string
    /** The one fact each collapsed row carries. `null` draws nothing. */
    previews?: Partial<Record<K, string | null>>
    /** Open before anyone has touched this rail. Defaults to the first widget. */
    defaultOpen?: readonly K[]
  }>(),
  { previews: undefined, defaultOpen: undefined },
)

const emit = defineEmits<{ expand: [K] }>()

const route = useRoute()
const layout = useLayoutStore()

const defaults = computed<string[]>(() => {
  if (props.defaultOpen) return [...props.defaultOpen]
  const first = props.widgets[0]
  return first ? [first.id] : []
})

/**
 * `null` from the store means nobody has touched this rail, which is different
 * from having closed everything — otherwise closing the last widget would
 * silently re-open the defaults on the next page.
 */
const open = computed<string[]>(() => layout.openWidgets(props.surface) ?? defaults.value)

function setOpen(id: K, next: boolean) {
  layout.setWidgetOpen(props.surface, id, next, open.value)
}

function applyUrlTab() {
  const wanted = route.query.tab
  if (typeof wanted !== 'string') return
  if (props.widgets.some((widget) => widget.id === wanted)) setOpen(wanted as K, true)
}

applyUrlTab()
watch(() => route.query.tab, applyUrlTab)
</script>

<template>
  <!-- `kn-widget-rail` makes the stack sticky *and* self-scrolling above `lg`:
       bounded to the viewport, so a rail taller than the screen is reachable
       without scrolling the document out from under it. See style.css. -->
  <aside class="kn-widget-rail space-y-3">
    <!-- Above the stack and outside it: the table of contents belongs to the
         page being read, not to the facts about it. -->
    <slot name="before" />

    <RailSection
      v-for="widget in widgets"
      :key="widget.id"
      :icon="widget.icon"
      :title="widget.label"
      :preview="previews?.[widget.id] ?? null"
      :open="open.includes(widget.id)"
      :expandable="widget.expandable"
      @update:open="setOpen(widget.id, $event)"
      @expand="emit('expand', widget.id)"
    >
      <slot :name="`widget-${widget.id}`" />
    </RailSection>

    <slot name="after" />
  </aside>
</template>
