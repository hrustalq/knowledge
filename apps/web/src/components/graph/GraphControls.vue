<script setup lang="ts">
/**
 * The graph's instrument panel.
 *
 * Built out of the rail-widget vocabulary rather than out of a generic
 * settings popover: three collapsible sections, each collapsed to one row that
 * carries the fact deciding whether to open it. That is the same reasoning as
 * the page rail — the alternative is tabs, where two of the three answers are
 * always a click away — and it means the panel reads as part of this product
 * instead of as a graph library's chrome bolted onto it.
 *
 * Legend rows are the filter. A separate list of checkboxes duplicating the
 * colors would be two things to keep in sync and one more thing to read.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ChevronRight, Search, X } from 'lucide-vue-next'
import { Checkbox } from '@/components/ui/checkbox'
import { labelFor } from '@/lib/labels'
import { ENTITY_TYPE_ORDER, entityCssVar } from './graph-theme'
import { PAGES_GROUP, type GraphOptions } from './graph-model'

const props = defineProps<{
  options: GraphOptions
  query: string
  counts: Record<string, number>
  orphans: number
  /** Hidden when the source graph has no entities to speak of. */
  showEntityControls?: boolean
}>()

const emit = defineEmits<{
  'update:options': [GraphOptions]
  'update:query': [string]
}>()

const { t } = useI18n()

const open = ref<Record<string, boolean>>({ filters: true, groups: true, forces: false })
const toggle = (k: string) => (open.value[k] = !open.value[k])

function set<K extends keyof GraphOptions>(key: K, value: GraphOptions[K]) {
  emit('update:options', { ...props.options, [key]: value })
}

/** Only the groups actually present, in a structural order, pages first. */
const groups = computed(() => {
  const keys = Object.keys(props.counts)
  const entityKeys = ENTITY_TYPE_ORDER.filter((k) => keys.includes(k))
  const rest = keys.filter((k) => k !== PAGES_GROUP && !entityKeys.includes(k)).sort()
  return [
    ...(props.counts[PAGES_GROUP] ? [{ key: PAGES_GROUP, count: props.counts[PAGES_GROUP]!, cssVar: '--primary', page: true }] : []),
    ...[...entityKeys, ...rest].map((k) => ({ key: k, count: props.counts[k]!, cssVar: entityCssVar(k), page: false })),
  ]
})

function toggleGroup(key: string) {
  const hidden = props.options.hidden.includes(key)
    ? props.options.hidden.filter((h) => h !== key)
    : [...props.options.hidden, key]
  set('hidden', hidden)
}

const activeFilters = computed(() => {
  const n = [props.options.showEntities, props.options.showOrphans, props.options.showInferred].filter((x) => !x).length
  return n + props.options.hidden.length
})

const hiddenGroups = computed(() => props.options.hidden.length)
</script>

<template>
  <div
    class="pointer-events-auto w-62 overflow-hidden rounded-xl border bg-card/90 shadow-[0_16px_48px_-12px] shadow-foreground/15 backdrop-blur-md dark:shadow-black/50"
  >
    <!-- Filters ------------------------------------------------------------->
    <button
      class="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      :aria-expanded="open.filters"
      @click="toggle('filters')"
    >
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150" :class="open.filters ? 'rotate-90' : ''" />
      <span class="text-sm font-medium">{{ t('graph.filters') }}</span>
      <span v-if="activeFilters" class="ml-auto text-xs text-muted-foreground">{{ t('graph.nActive', { n: activeFilters }) }}</span>
    </button>

    <div v-if="open.filters" class="space-y-2.5 border-t px-3 py-3">
      <div class="relative">
        <Search class="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <input
          :value="query"
          type="search"
          :placeholder="t('graph.searchNodes')"
          class="h-8 w-full rounded-md border bg-background pl-8 pr-7 text-xs shadow-xs transition-shadow outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          @input="emit('update:query', ($event.target as HTMLInputElement).value)"
        />
        <button
          v-if="query"
          class="absolute right-1.5 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          :aria-label="t('common.clear')"
          @click="emit('update:query', '')"
        >
          <X class="size-3" />
        </button>
      </div>

      <label v-if="showEntityControls" class="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox :model-value="options.showEntities" @update:model-value="set('showEntities', !!$event)" />
        <span class="flex-1">{{ t('graph.showEntities') }}</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox :model-value="options.showOrphans" @update:model-value="set('showOrphans', !!$event)" />
        <span class="flex-1">{{ t('graph.showOrphans') }}</span>
        <span v-if="orphans" class="tabular-nums text-muted-foreground">{{ orphans }}</span>
      </label>
      <label class="flex cursor-pointer items-center gap-2 text-xs">
        <Checkbox :model-value="options.showInferred" @update:model-value="set('showInferred', !!$event)" />
        <span class="flex-1">{{ t('graph.showInferred') }}</span>
        <!-- The dash is the legend: it is exactly how an inferred edge draws. -->
        <svg width="18" height="4" class="shrink-0 text-muted-foreground" aria-hidden="true">
          <line x1="0" y1="2" x2="18" y2="2" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2.5 3" />
        </svg>
      </label>
      <p v-if="!options.showEntities" class="pt-0.5 text-[0.68rem] leading-snug text-muted-foreground">
        {{ t('graph.derivedLinksNote') }}
      </p>
    </div>

    <!-- Groups -------------------------------------------------------------->
    <button
      class="flex w-full items-center gap-2 border-t px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      :aria-expanded="open.groups"
      @click="toggle('groups')"
    >
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150" :class="open.groups ? 'rotate-90' : ''" />
      <span class="text-sm font-medium">{{ t('graph.groups') }}</span>
      <span class="ml-auto text-xs text-muted-foreground">
        {{ hiddenGroups ? t('graph.nHidden', { n: hiddenGroups }) : groups.length }}
      </span>
    </button>

    <div v-if="open.groups" class="border-t px-1.5 py-1.5">
      <button
        v-for="g in groups"
        :key="g.key"
        class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition-colors hover:bg-muted/60"
        :class="options.hidden.includes(g.key) ? 'opacity-40' : ''"
        :aria-pressed="!options.hidden.includes(g.key)"
        @click="toggleGroup(g.key)"
      >
        <!-- Filled disc for pages, ring for entities: the same two silhouettes
             the canvas draws, so the legend is a sample and not a translation. -->
        <span
          class="size-2.5 shrink-0 rounded-full"
          :style="g.page
            ? { background: `var(${g.cssVar})` }
            : { boxShadow: `inset 0 0 0 1.5px var(${g.cssVar})` }"
        />
        <span class="flex-1 truncate">{{ g.page ? t('graph.kindPages') : labelFor(t, 'entityType', g.key) }}</span>
        <span class="shrink-0 tabular-nums text-muted-foreground">{{ g.count }}</span>
      </button>
    </div>

    <!-- Forces -------------------------------------------------------------->
    <button
      class="flex w-full items-center gap-2 border-t px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
      :aria-expanded="open.forces"
      @click="toggle('forces')"
    >
      <ChevronRight class="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150" :class="open.forces ? 'rotate-90' : ''" />
      <span class="text-sm font-medium">{{ t('graph.layout') }}</span>
    </button>

    <div v-if="open.forces" class="space-y-3 border-t px-3 py-3">
      <label class="block">
        <span class="mb-1 flex items-center justify-between text-xs">
          <span>{{ t('graph.repel') }}</span>
          <span class="tabular-nums text-muted-foreground">{{ options.repel.toFixed(1) }}</span>
        </span>
        <input
          type="range" min="0.3" max="3" step="0.1" class="kn-range"
          :value="options.repel"
          @input="set('repel', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="block">
        <span class="mb-1 flex items-center justify-between text-xs">
          <span>{{ t('graph.linkDistance') }}</span>
          <span class="tabular-nums text-muted-foreground">{{ options.linkDistance.toFixed(1) }}</span>
        </span>
        <input
          type="range" min="0.4" max="3" step="0.1" class="kn-range"
          :value="options.linkDistance"
          @input="set('linkDistance', Number(($event.target as HTMLInputElement).value))"
        />
      </label>
      <label class="block">
        <span class="mb-1 flex items-center justify-between text-xs">
          <span>{{ t('graph.labelDensity') }}</span>
        </span>
        <!-- Inverted: dragging right shows more names, which is the direction
             the reader is thinking in. The value it drives is a zoom floor. -->
        <input
          type="range" min="0" max="1.6" step="0.05" class="kn-range"
          :value="1.6 - options.labelZoom"
          @input="set('labelZoom', 1.6 - Number(($event.target as HTMLInputElement).value))"
        />
      </label>
    </div>
  </div>
</template>
