<script setup lang="ts">
// Result list for the search sheet. Denser than the /search page's card stack —
// a sheet earns its keep by showing more at once.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { SearchX } from 'lucide-vue-next'
import type { SearchResponse } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'

const { t } = useI18n()

defineProps<{
  response: SearchResponse | null
  busy: boolean
  error: string | null
  activeFilterCount: number
}>()
const emit = defineEmits<{ navigate: []; 'clear-filters': [] }>()
</script>

<template>
  <div>
    <div v-if="busy && !response" class="space-y-4">
      <div v-for="i in 5" :key="i" class="space-y-2">
        <Skeleton class="h-4 w-1/3" />
        <Skeleton class="h-3 w-full" />
        <Skeleton class="h-3 w-4/5" />
      </div>
    </div>

    <p v-else-if="error" class="text-sm text-destructive">
      {{ error }} — check your connection and try again.
    </p>

    <!-- First run: name what the filters do rather than showing a blank panel. -->
    <div
      v-else-if="!response"
      class="flex flex-col items-center gap-1.5 py-16 text-center text-muted-foreground"
    >
      <p class="text-sm">{{ t('search.searchEveryPage') }}</p>
      <p class="max-w-sm text-xs leading-relaxed">
        Narrow by project, category or tag on the left. Hybrid mode also follows relation edges to
        surface pages that never mention your words.
      </p>
    </div>

    <div
      v-else-if="response.results.length === 0"
      class="flex flex-col items-center gap-2 py-16 text-center"
    >
      <SearchX class="size-5 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">No pages matched.</p>
      <p v-if="activeFilterCount > 0" class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {{ activeFilterCount }} filter{{ activeFilterCount === 1 ? ' is' : 's are' }} narrowing the
        ranked candidates, so matches further down can be cut off.
      </p>
      <p v-else class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        Try a broader query, or switch mode to keyword for an exact-word match.
      </p>
      <button
        v-if="activeFilterCount > 0"
        type="button"
        class="text-xs text-primary hover:underline"
        @click="emit('clear-filters')"
      >
        Clear filters
      </button>
    </div>

    <div v-else :class="busy ? 'opacity-60 transition-opacity' : ''">
      <ul class="divide-y">
        <li v-for="r in response.results" :key="r.chunkId">
          <RouterLink
            :to="`/documents/${r.documentId}`"
            class="block rounded-md px-2 py-3 transition-colors hover:bg-muted/60"
            @click="emit('navigate')"
          >
            <div class="flex items-baseline justify-between gap-3">
              <span class="truncate text-sm font-medium">{{ r.title }}</span>
              <!-- Scores round to 0 under the stub embedding provider; a column
                   of zeroes reads as broken, so show one only when it says something. -->
              <span
                v-if="r.score > 0"
                class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
              >
                {{ r.score }}
              </span>
            </div>
            <p class="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              {{ r.snippet }}…
            </p>
            <div v-if="r.entities?.length" class="mt-1.5 flex flex-wrap gap-1">
              <Badge v-for="e in r.entities" :key="e.key" variant="secondary" class="text-[10px]">
                {{ e.name }}
              </Badge>
            </div>
          </RouterLink>
        </li>
      </ul>

      <template v-if="response.related?.length">
        <h3
          class="mt-6 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          Related via graph
        </h3>
        <ul class="divide-y">
          <li v-for="r in response.related" :key="r.documentId">
            <RouterLink
              :to="`/documents/${r.documentId}`"
              class="block rounded-md px-2 py-2.5 transition-colors hover:bg-muted/60"
              @click="emit('navigate')"
            >
              <div class="flex items-baseline justify-between gap-3">
                <span class="truncate text-sm">{{ r.title }}</span>
                <span class="shrink-0 text-xs tabular-nums text-muted-foreground">
                  {{ t('count.hops', { n: r.distance }, r.distance) }}
                </span>
              </div>
              <p class="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                via {{ r.via.map((v) => `${v.relationType} ${v.entityKey}`).join(', ') }}
              </p>
            </RouterLink>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
