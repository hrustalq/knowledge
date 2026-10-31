<script setup lang="ts">
// Result list for every search surface: the app's sheet and /search page, and a
// published site's reader (#205), so a change to a row changes it everywhere.
// Denser than a card stack — a sheet earns its keep by showing more at once.
// Rows come as a source-neutral SearchView; a row links by router path in the
// app and by plain href in the reader, which has no router.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { History, SearchX } from 'lucide-vue-next'
import { Badge } from '@/shared/ui/badge'
import { Skeleton } from '@/shared/ui/skeleton'
import { formatDate, formatDateTime } from '@/shared/utils/format'
import { VerificationBadge } from '@/entities/document'
import type { SearchCopy, SearchFailure, SearchHit, SearchView } from '../model/use-search'

const { t } = useI18n()

const props = defineProps<{
  response: SearchView | null
  busy: boolean
  error: SearchFailure | null
  activeFilterCount: number
  /** What the idle and no-match states say; page search's wording when omitted. */
  copy?: SearchCopy
  /**
   * The listbox the query field drives (#651): its id, and the row the arrow
   * keys are on. Without an id the list is a plain list of links.
   */
  listId?: string
  activeIndex?: number
}>()

/** A row's element id, which the query field's `aria-activedescendant` names. */
const optionId = (i: number) => (props.listId ? `${props.listId}-${i}` : undefined)

const say = (k: keyof SearchCopy, fallback: string) => props.copy?.[k] ?? t(fallback)

/** A router link in the app, a plain link in the reader, plain text for a hit with nowhere to go. */
const linkIs = (r: SearchHit) => (r.to ? RouterLink : r.href ? 'a' : 'div')
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
      <p class="text-sm">{{ say('idle', 'search.searchEveryPage') }}</p>
      <p class="max-w-sm text-xs leading-relaxed">
        {{ say('idleHint', 'search.emptyHint') }}
      </p>
    </div>

    <div
      v-else-if="response.results.length === 0"
      class="flex flex-col items-center gap-2 py-16 text-center"
    >
      <SearchX class="size-5 text-muted-foreground" />
      <p class="text-sm text-muted-foreground">{{ say('none', 'search.noMatches') }}</p>
      <p v-if="activeFilterCount > 0" class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {{ t('search.narrowedBy', { n: activeFilterCount }, activeFilterCount) }}
      </p>
      <p v-else class="max-w-sm text-xs leading-relaxed text-muted-foreground">
        {{ say('noneHint', 'search.broaderQuery') }}
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
      <ul
        class="divide-y"
        :id="listId"
        :role="listId ? 'listbox' : undefined"
        :aria-label="listId ? t('search.resultsLabel') : undefined"
      >
        <li v-for="(r, i) in response.results" :key="r.key" :role="listId ? 'none' : undefined">
          <component
            :is="linkIs(r)"
            :id="optionId(i)"
            :to="r.to"
            :href="r.to ? undefined : r.href"
            :target="r.external ? '_blank' : undefined"
            :rel="r.external ? 'noopener noreferrer' : undefined"
            :role="listId ? 'option' : undefined"
            :aria-selected="listId ? i === activeIndex : undefined"
            class="block rounded-md px-2 py-3 transition-colors"
            :class="[r.to || r.href ? 'hover:bg-muted/60' : '', listId && i === activeIndex ? 'bg-muted/60' : '']"
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
                <!-- #81: on an as-of search, text the page has since replaced.
                     Outline and muted: it is a date, not a warning. -->
                <Badge
                  v-if="r.supersededAt"
                  variant="outline"
                  class="shrink-0 gap-1 text-caption font-normal text-muted-foreground"
                  :title="formatDateTime(r.supersededAt)"
                >
                  <History class="size-3" aria-hidden="true" />
                  {{ t('search.asOf.superseded', { date: formatDate(r.supersededAt) }) }}
                </Badge>
              </span>
              <!-- No score (#651): under hybrid fusion it is a rank-fusion value,
                   not a percentage, and 0.03 read as a near-miss. -->
            </div>
            <p v-if="r.snippet.length" class="mt-1 line-clamp-2 text-xs leading-relaxed text-muted-foreground">
              <template v-for="(part, j) in r.snippet" :key="j">
                <mark v-if="part.hit" class="rounded-sm bg-primary/15 px-0.5 text-foreground">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </p>
            <div v-if="r.badges.length" class="mt-1.5 flex flex-wrap gap-1">
              <Badge v-for="b in r.badges" :key="b.key" variant="secondary" class="text-caption">
                {{ b.label }}
              </Badge>
            </div>
          </component>
        </li>
      </ul>

      <template v-if="response.related.length">
        <h3
          class="mt-6 mb-1 text-caption font-semibold uppercase tracking-wider text-muted-foreground"
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
              <p class="mt-0.5 truncate font-mono text-caption text-muted-foreground">
                {{ t('search.via', { path: r.via }) }}
              </p>
            </RouterLink>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
