<script setup lang="ts">
// Result list for every search surface: the app's sheet and /search page, and a
// published site's reader (#205), so a change to a row changes it everywhere.
// Denser than a card stack — a sheet earns its keep by showing more at once.
// Rows come as a source-neutral SearchView; a row links by router path in the
// app and by plain href in the reader, which has no router.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { SearchX } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import VerificationBadge from '@/components/verification/VerificationBadge.vue'
import type { SearchFailure, SearchHit, SearchView } from './use-search'

const { t } = useI18n()

defineProps<{
  response: SearchView | null
  busy: boolean
  error: SearchFailure | null
  activeFilterCount: number
}>()

/** A router link in the app, a plain link in the reader. */
const linkIs = (r: SearchHit) => (r.to ? RouterLink : 'a')
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

    <p v-else-if="error?.notice" class="py-16 text-center text-sm text-muted-foreground">
      {{ error.message }}
    </p>
    <p v-else-if="error" class="text-sm text-destructive">
      {{ t('search.failedCheckConnection', { error: error.message }) }}
    </p>

    <!-- First run: name what the filters do rather than showing a blank panel. -->
    <div
      v-else-if="!response"
      class="flex flex-col items-center gap-1.5 py-16 text-center text-muted-foreground"
    >
      <p class="text-sm">{{ t('search.searchEveryPage') }}</p>
      <p class="max-w-sm text-xs leading-relaxed">
        {{ t('search.emptyHint') }}
      </p>
    </div>

    <div
      v-else-if="response.results.length === 0"
      class="flex flex-col items-center gap-2 py-16 text-center"
    >
      <SearchX class="size-5 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">{{ t('search.noMatches') }}</p>
      <p v-if="activeFilterCount > 0" class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {{ t('search.narrowedBy', { n: activeFilterCount }, activeFilterCount) }}
      </p>
      <p v-else class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {{ t('search.broaderQuery') }}
      </p>
      <button
        v-if="activeFilterCount > 0"
        type="button"
        class="text-xs text-primary hover:underline"
        @click="emit('clear-filters')"
      >
        {{ t('search.clearAllFilters') }}
      </button>
    </div>

    <div v-else :class="busy ? 'opacity-60 transition-opacity' : ''">
      <ul class="divide-y">
        <li v-for="r in response.results" :key="r.key">
          <component
            :is="linkIs(r)"
            :to="r.to"
            :href="r.to ? undefined : r.href"
            class="block rounded-md px-2 py-3 transition-colors hover:bg-muted/60"
            @click="emit('navigate')"
          >
            <div class="flex items-baseline justify-between gap-3">
              <span class="flex min-w-0 items-center gap-2">
                <span class="truncate text-sm font-medium">{{ r.title }}</span>
                <!-- The trust the re-rank read (docs/features/39), so a reader can
                     see why a weaker match sits above a stronger one. Unverified
                     is the ordinary state and says nothing. -->
                <VerificationBadge
                  v-if="r.trust && r.trust !== 'unverified'"
                  :state="r.trust"
                  size="xs"
                />
              </span>
              <!-- Scores round to 0 under the stub embedding provider; a column
                   of zeroes reads as broken, so show one only when it says something. -->
              <span
                v-if="r.score && r.score > 0"
                class="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
              >
                {{ r.score }}
              </span>
            </div>
            <p v-if="r.snippet.length" class="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              <template v-for="(part, j) in r.snippet" :key="j">
                <mark v-if="part.hit" class="rounded-sm bg-primary/15 px-0.5 text-foreground">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </p>
            <div v-if="r.badges.length" class="mt-1.5 flex flex-wrap gap-1">
              <Badge v-for="b in r.badges" :key="b.key" variant="secondary" class="text-[10px]">
                {{ b.label }}
              </Badge>
            </div>
          </component>
        </li>
      </ul>

      <template v-if="response.related.length">
        <h3
          class="mt-6 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
        >
          {{ t('search.relatedViaGraph') }}
        </h3>
        <ul class="divide-y">
          <li v-for="r in response.related" :key="r.key">
            <RouterLink
              :to="r.to"
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
                {{ t('search.via', { path: r.via }) }}
              </p>
            </RouterLink>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
