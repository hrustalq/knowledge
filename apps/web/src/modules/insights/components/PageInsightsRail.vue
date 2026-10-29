<script setup lang="ts">
/**
 * One page's reading, in the document rail (#79): the last 30 days of views
 * split by who read — people, the assistant, agents — with readers, median
 * read time and when a person last opened it. Counts only, never who.
 *
 * The page owns the query (its collapsed row previews the view count), so
 * this only draws.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { TRAFFIC_CLASSES, type PageInsightsResponse } from '@knowledge/contracts'
import { formatDuration, formatNumber, formatRelative, formatDate, formatDateTime } from '@/shared/utils/format'
import DailyBars from './DailyBars.vue'
import { TRAFFIC_BAR, TRAFFIC_SEGMENTS, trafficPoints } from '../model/traffic'

const props = defineProps<{ insights: PageInsightsResponse }>()
const { t } = useI18n()

const points = computed(() => trafficPoints(props.insights.series))
/** Collection began inside the window: the early, empty days are not quiet, just uncounted. */
const partial = computed(() => !!props.insights.collectingSince && props.insights.collectingSince > props.insights.from)
</script>

<template>
  <div class="space-y-3 text-sm">
    <div class="flex items-end justify-between gap-3">
      <p class="leading-none">
        <span class="text-2xl font-semibold tabular-nums">{{ formatNumber(insights.views) }}</span>
        <span class="ml-1 text-xs text-muted-foreground">{{ t('analytics.viewsWord', insights.views) }}</span>
      </p>
      <p class="text-xs text-muted-foreground">{{ t('analytics.last30') }}</p>
    </div>

    <ul class="flex flex-wrap gap-x-3 gap-y-1 text-xs">
      <li v-for="c in TRAFFIC_CLASSES" :key="c" class="flex items-center gap-1.5" :title="t(`analytics.trafficHint.${c}`)">
        <span class="size-2 shrink-0 rounded-[2px]" :class="TRAFFIC_BAR[c]" aria-hidden="true" />
        <span class="text-muted-foreground">{{ t(`analytics.traffic.${c}`) }}</span>
        <span class="font-medium tabular-nums">{{ formatNumber(insights.byClass[c]) }}</span>
      </li>
    </ul>

    <DailyBars
      v-if="insights.views > 0"
      :from="insights.from"
      :to="insights.to"
      :points="points"
      :segments="TRAFFIC_SEGMENTS"
      :height="40"
      :label="t('analytics.viewsChartLabel', { n: 30 })"
      :point-title="(date, [human, assisted, agent]) => t('analytics.chartPoint', { date, human, assisted, agent })"
    />

    <dl class="space-y-1.5">
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">{{ t('analytics.uniqueReaders') }}</dt>
        <dd class="font-medium tabular-nums">{{ formatNumber(insights.uniqueReaders) }}</dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">{{ t('analytics.medianRead') }}</dt>
        <dd class="font-medium tabular-nums">{{ insights.medianReadMs === null ? '—' : formatDuration(insights.medianReadMs) }}</dd>
      </div>
      <div class="flex justify-between gap-2">
        <dt class="text-muted-foreground">{{ t('analytics.lastHumanView') }}</dt>
        <dd v-if="insights.lastHumanViewAt" class="text-right font-medium" :title="formatDateTime(insights.lastHumanViewAt)">
          {{ formatRelative(insights.lastHumanViewAt) }}
        </dd>
        <dd v-else class="text-muted-foreground">—</dd>
      </div>
    </dl>

    <p v-if="!insights.collectingSince" class="text-xs text-muted-foreground">{{ t('analytics.notCollecting') }}</p>
    <p v-else-if="partial" class="text-xs text-muted-foreground">
      {{ t('analytics.collectingSince', { when: formatDate(insights.collectingSince) }) }}
    </p>
  </div>
</template>
