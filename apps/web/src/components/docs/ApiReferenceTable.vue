<script setup lang="ts">
/**
 * The endpoint table, from `reference.generated.json` — 174 rows across 20 tags,
 * so it opens filtered rather than as a wall.
 *
 * The access column is the reason this is a table and not a link to Swagger:
 * Swagger documents the shape of a request, and says nothing about which role
 * may make it. That answer is scanned out of the controllers' `@Access`
 * decorators, so it cannot drift from what the guards actually enforce.
 */
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { Search } from 'lucide-vue-next'
import { accessLabel, endpoints } from '@/pages/docs/bundle'
import { Input } from '@/components/ui/input'

const { t } = useI18n()

const tags = [...new Set(endpoints.map((e) => e.tag))].sort()
const tag = ref<string | null>(null)
const query = ref('')

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return endpoints.filter(
    (endpoint) =>
      (!tag.value || endpoint.tag === tag.value) &&
      (!needle ||
        endpoint.path.toLowerCase().includes(needle) ||
        endpoint.summary.toLowerCase().includes(needle) ||
        endpoint.method.toLowerCase() === needle),
  )
})

/** Method colour carries the risk, so a destructive route reads as one. */
const METHOD_CLASS: Record<string, string> = {
  GET: 'text-sky-600 dark:text-sky-400',
  POST: 'text-emerald-600 dark:text-emerald-400',
  PUT: 'text-amber-600 dark:text-amber-400',
  PATCH: 'text-amber-600 dark:text-amber-400',
  DELETE: 'text-destructive',
}

/**
 * `authenticated` means the route resolves a principal but checks no workspace
 * — correct for a handful, a gap anywhere else. It is the one value worth
 * making visually distinct, since the whole point of listing access is to make
 * that set auditable.
 */
function accessClass(label: string): string {
  if (label === 'authenticated') return 'text-amber-600 dark:text-amber-400'
  if (label === 'public') return 'text-muted-foreground'
  return 'text-foreground/70'
}
</script>

<template>
  <div class="not-prose my-6 space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-48 flex-1">
        <Search class="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input v-model="query" :placeholder="t('docs.filterEndpoints')" class="h-8 pl-8 text-sm" />
      </div>
      <span class="text-xs text-muted-foreground">{{ t('docs.endpointCount', { n: shown.length }) }}</span>
    </div>

    <div class="flex flex-wrap gap-1">
      <button
        type="button"
        class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
        :class="tag === null ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'"
        @click="tag = null"
      >
        {{ t('docs.allTags') }}
      </button>
      <button
        v-for="name in tags"
        :key="name"
        type="button"
        class="rounded-full border px-2.5 py-0.5 text-xs transition-colors"
        :class="tag === name ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent'"
        @click="tag = name"
      >
        {{ name }}
      </button>
    </div>

    <!--
      Rows, not a four-column table. Paths run to 40 characters and summaries
      to a sentence, which in an article column means either a horizontal
      scroll or a summary column too narrow to read — and the summary is the
      column someone came here for. Stacking puts the identity of the endpoint
      on one line and its description under it, at full width.
    -->
    <ul class="divide-y rounded-md border">
      <li v-for="endpoint in shown" :key="`${endpoint.method} ${endpoint.path}`" class="px-3 py-2">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span class="font-mono text-xs font-semibold" :class="METHOD_CLASS[endpoint.method]">
            {{ endpoint.method }}
          </span>
          <span class="font-mono text-xs break-all">{{ endpoint.path }}</span>
          <span class="ml-auto shrink-0 text-[11px] whitespace-nowrap" :class="accessClass(accessLabel(endpoint))">
            {{ accessLabel(endpoint) }}
          </span>
        </div>
        <p v-if="endpoint.summary" class="mt-0.5 text-xs text-muted-foreground">{{ endpoint.summary }}</p>
      </li>
      <li v-if="shown.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
        {{ t('docs.noEndpoints') }}
      </li>
    </ul>
  </div>
</template>
