<script setup lang="ts">
/**
 * A project's reading (#79), on its overview page, for editors: views over a
 * range split by who read, the most read pages, and the two lists a curator
 * acts on — pages nobody has opened, and dead ones (unread and returned by no
 * search). Every page here is one the reader may open; the API filters.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { TRAFFIC_CLASSES, type ProjectAnalyticsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { formatDate, formatDuration, formatNumber, formatRelative } from '@/lib/format'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import DailyBars from './DailyBars.vue'
import { TRAFFIC_BAR, TRAFFIC_SEGMENTS, trafficPoints } from './traffic'

const props = defineProps<{ projectId: string }>()
const { t } = useI18n()

const RANGES = [7, 30, 90] as const
const days = ref<number>(30)

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/projects/{id}/analytics', {
      path: { id: props.projectId },
      query: { days: days.value },
    }),
  ),
)
const data = computed(() => query.data.value as ProjectAnalyticsResponse | undefined)
const points = computed(() => trafficPoints(data.value?.series ?? []))

/** Dead pages need reads counted across their whole window; until then the empty list is not a verdict. */
const deadPending = computed(() => {
  const d = data.value
  if (!d) return false
  return !d.collectingSince || Date.parse(d.collectingSince) > Date.now() - d.deadAfterDays * 86_400_000
})
</script>

<template>
  <section class="space-y-3" :aria-label="t('analytics.project.title')">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {{ t('analytics.project.title') }}
      </h2>
      <div class="flex gap-1" role="group" :aria-label="t('analytics.project.range')">
        <Button
          v-for="n in RANGES"
          :key="n"
          :variant="days === n ? 'secondary' : 'ghost'"
          size="xs"
          :aria-pressed="days === n"
          @click="days = n"
        >
          {{ t('analytics.project.days', { n }) }}
        </Button>
      </div>
    </div>

    <div class="space-y-5 rounded-xl border bg-card p-5">
      <template v-if="query.isPending.value">
        <Skeleton class="h-12 w-full max-w-sm" />
        <Skeleton class="h-16 w-full" />
      </template>

      <p v-else-if="query.isError.value" class="text-sm text-destructive">{{ (query.error.value as Error).message }}</p>

      <template v-else-if="data">
        <p v-if="!data.collectingSince" class="text-sm text-muted-foreground">{{ t('analytics.notCollecting') }}</p>

        <template v-else>
          <dl class="flex flex-wrap gap-x-10 gap-y-3">
            <div>
              <dt class="text-xs text-muted-foreground">{{ t('analytics.views') }}</dt>
              <dd class="text-2xl font-semibold tabular-nums">{{ formatNumber(data.views) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ t('analytics.uniqueReaders') }}</dt>
              <dd class="text-2xl font-semibold tabular-nums">{{ formatNumber(data.uniqueReaders) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-muted-foreground">{{ t('analytics.medianRead') }}</dt>
              <dd class="text-2xl font-semibold tabular-nums">
                {{ data.medianReadMs === null ? '—' : formatDuration(data.medianReadMs) }}
              </dd>
            </div>
          </dl>

          <div class="space-y-2">
            <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <li v-for="c in TRAFFIC_CLASSES" :key="c" class="flex items-center gap-1.5" :title="t(`analytics.trafficHint.${c}`)">
                <span class="size-2 shrink-0 rounded-[2px]" :class="TRAFFIC_BAR[c]" aria-hidden="true" />
                <span class="text-muted-foreground">{{ t(`analytics.traffic.${c}`) }}</span>
                <span class="font-medium tabular-nums">{{ formatNumber(data.byClass[c]) }}</span>
              </li>
            </ul>
            <DailyBars
              v-if="data.views > 0"
              :from="data.from"
              :to="data.to"
              :points="points"
              :segments="TRAFFIC_SEGMENTS"
              :height="64"
              :label="t('analytics.viewsChartLabel', { n: days })"
              :point-title="(date, [human, assisted, agent]) => t('analytics.chartPoint', { date, human, assisted, agent })"
            />
            <p v-else class="text-sm text-muted-foreground">{{ t('analytics.project.noViews') }}</p>
            <p v-if="Date.parse(data.collectingSince) > Date.parse(data.from)" class="text-xs text-muted-foreground">
              {{ t('analytics.collectingSince', { when: formatDate(data.collectingSince) }) }}
            </p>
          </div>

          <div v-if="data.topPages.length" class="space-y-1.5">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('analytics.project.topPages') }}</h3>
            <ol class="divide-y rounded-lg border">
              <li v-for="p in data.topPages" :key="p.documentId" class="flex items-baseline gap-3 px-3 py-2 text-sm">
                <RouterLink :to="`/documents/${p.documentId}`" class="min-w-0 flex-1 truncate hover:underline">{{ p.title }}</RouterLink>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {{ t('analytics.viewsCount', { n: formatNumber(p.views) }, p.views) }}
                  <template v-if="p.medianReadMs !== null"> · {{ formatDuration(p.medianReadMs) }}</template>
                </span>
              </li>
            </ol>
          </div>
        </template>

        <div class="grid gap-5 md:grid-cols-2">
          <div v-if="data.collectingSince" class="min-w-0 space-y-1.5">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('analytics.project.neverRead') }}</h3>
            <p v-if="!data.neverRead.length" class="text-sm text-muted-foreground">{{ t('analytics.project.none') }}</p>
            <ul v-else class="space-y-1">
              <li v-for="p in data.neverRead" :key="p.documentId" class="flex items-baseline gap-2 text-sm">
                <RouterLink :to="`/documents/${p.documentId}`" class="min-w-0 flex-1 truncate hover:underline">{{ p.title }}</RouterLink>
                <span class="shrink-0 text-xs text-muted-foreground">
                  {{ t('analytics.project.createdAgo', { when: formatRelative(p.createdAt) }) }}
                </span>
              </li>
            </ul>
          </div>

          <div class="min-w-0 space-y-1.5">
            <h3 class="text-xs font-medium text-muted-foreground">{{ t('analytics.project.dead') }}</h3>
            <p class="text-xs text-muted-foreground">
              {{ deadPending ? t('analytics.project.deadNotYet', { n: data.deadAfterDays }) : t('analytics.project.deadHint', { n: data.deadAfterDays }) }}
            </p>
            <p v-if="!deadPending && !data.dead.length" class="text-sm text-muted-foreground">{{ t('analytics.project.none') }}</p>
            <ul v-else-if="data.dead.length" class="space-y-1">
              <li v-for="p in data.dead" :key="p.documentId" class="text-sm">
                <RouterLink :to="`/documents/${p.documentId}`" class="block truncate hover:underline">{{ p.title }}</RouterLink>
              </li>
            </ul>
          </div>
        </div>
      </template>
    </div>
  </section>
</template>
