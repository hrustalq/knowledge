<script setup lang="ts">
/**
 * One page's quality, in the document rail (#74, phase 5).
 *
 * The score and when it was taken, then where the points went: six dimension
 * rows, the issues the auditor named (a broken link, a rule broken with the
 * passage it quoted, a near-duplicate), the near-duplicate pages themselves,
 * and the score over time. The page hosting this only shows the widget once a
 * score exists, so there is no "not audited" state to draw here.
 *
 * The API has already dropped any peer the reader may not open, along with the
 * issue that named it — nothing here filters.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { DocumentQualityResponse, QualityIssue } from '@knowledge/contracts'
import { formatRelative } from '@/lib/format'
import QualityHistoryChart from './QualityHistoryChart.vue'
import QualityMeter from './QualityMeter.vue'
import { QUALITY_DIMENSIONS, SEVERITY_HUE, scoreTone } from './quality-ui'

const props = defineProps<{ quality: DocumentQualityResponse }>()

const { t } = useI18n()

/** Issues shown before "show all": the rail is a glance, not the full report. */
const ISSUE_PREVIEW = 5
const showAll = ref(false)

const score = computed(() => props.quality.score!)
const threshold = computed(() => props.quality.lowThreshold)
const SEVERITY_RANK = { error: 0, warning: 1, info: 2 } as const
const issues = computed<QualityIssue[]>(() =>
  // Duplicates are listed below with their titles; an issue row would say it twice.
  [...score.value.issues.filter((i) => i.dimension !== 'duplication')].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  ),
)
const shownIssues = computed(() => (showAll.value ? issues.value : issues.value.slice(0, ISSUE_PREVIEW)))
</script>

<template>
  <div class="space-y-4 text-sm">
    <div class="flex items-end justify-between gap-3">
      <p class="leading-none">
        <span class="text-2xl font-semibold tabular-nums" :class="scoreTone(score.overall, threshold)">{{ score.overall }}</span>
        <span class="ml-0.5 text-xs text-muted-foreground">/ 100</span>
      </p>
      <p class="text-right text-xs text-muted-foreground" :title="score.createdAt">
        {{ t('quality.rail.scored', { when: formatRelative(score.createdAt) }) }}
      </p>
    </div>
    <p v-if="quality.stale" class="text-xs text-muted-foreground">{{ t('quality.rail.stale') }}</p>

    <dl class="space-y-2">
      <div v-for="d in QUALITY_DIMENSIONS" :key="d" class="grid grid-cols-[6.5rem_minmax(0,1fr)_1.75rem] items-center gap-2">
        <dt class="truncate text-xs text-muted-foreground" :title="t(`quality.dimension.${d}.hint`)">
          {{ t(`quality.dimension.${d}.label`) }}
        </dt>
        <dd><QualityMeter :value="score.dimensions[d]" :threshold="threshold" :label="t(`quality.dimension.${d}.label`)" /></dd>
        <dd
          class="text-right text-xs tabular-nums"
          :class="score.dimensions[d] === null ? 'text-muted-foreground' : scoreTone(score.dimensions[d], threshold)"
        >
          {{ score.dimensions[d] ?? '—' }}
        </dd>
      </div>
    </dl>

    <section v-if="issues.length" class="space-y-2 border-t pt-3" :aria-label="t('quality.rail.issues')">
      <h4 class="text-xs font-medium text-muted-foreground">{{ t('quality.rail.issues') }}</h4>
      <ul class="space-y-2.5">
        <li v-for="(issue, i) in shownIssues" :key="i" class="flex gap-2">
          <span
            class="mt-1.5 size-1.5 shrink-0 rounded-full"
            :style="{ background: SEVERITY_HUE[issue.severity] }"
            :title="t(`quality.severity.${issue.severity}`)"
            aria-hidden="true"
          />
          <div class="min-w-0 space-y-1">
            <p class="leading-snug">
              <span class="sr-only">{{ t(`quality.severity.${issue.severity}`) }}:</span>
              {{ issue.message }}
            </p>
            <p v-if="issue.quote" class="border-l pl-2 text-xs italic leading-snug text-muted-foreground">“{{ issue.quote }}”</p>
            <p class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>{{ t(`quality.dimension.${issue.dimension}.label`) }}</span>
              <code v-if="issue.ruleId" class="rounded-sm bg-muted px-1 font-mono">{{ issue.ruleId }}</code>
              <code v-if="issue.link" class="max-w-full truncate rounded-sm bg-muted px-1 font-mono">{{ issue.link }}</code>
            </p>
          </div>
        </li>
      </ul>
      <button
        v-if="issues.length > ISSUE_PREVIEW"
        type="button"
        class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        @click="showAll = !showAll"
      >
        {{ showAll ? t('common.showFewer') : t('common.andNMore', { n: issues.length - ISSUE_PREVIEW }) }}
      </button>
    </section>

    <section v-if="quality.peers.length" class="space-y-2 border-t pt-3" :aria-label="t('quality.rail.peers')">
      <h4 class="text-xs font-medium text-muted-foreground">{{ t('quality.rail.peers') }}</h4>
      <ul class="space-y-1.5">
        <li v-for="peer in quality.peers" :key="peer.documentId" class="flex items-baseline justify-between gap-2">
          <RouterLink :to="`/documents/${peer.documentId}`" class="min-w-0 truncate text-primary hover:underline">{{ peer.title }}</RouterLink>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
            {{ t('quality.rail.similarity', { n: Math.round(peer.similarity * 100) }) }}
          </span>
        </li>
      </ul>
    </section>

    <section v-if="quality.history.length > 1" class="space-y-2 border-t pt-3" :aria-label="t('quality.history.title')">
      <h4 class="text-xs font-medium text-muted-foreground">{{ t('quality.history.title') }}</h4>
      <QualityHistoryChart :points="quality.history" :threshold="threshold" compact />
    </section>
  </div>
</template>
