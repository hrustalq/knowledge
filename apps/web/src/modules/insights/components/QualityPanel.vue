<script setup lang="ts">
/**
 * The Quality tab of knowledge health (#74, phase 5): how good the pages in
 * scope are, from each page's newest auditor score.
 *
 * Read top to bottom it answers three questions in order — is it getting
 * better (history), where is it weak (dimensions, distribution), and what do I
 * fix first (the lowest pages, the rules most broken). The lists are on the
 * right once the panel is wide enough (a container query, not `lg`: with the
 * sidebar open the panel is far narrower than the viewport) because they are
 * what a reader acts on; the charts are what they read first.
 *
 * Every figure is the API's: the summary is computed at read time over the
 * pages the reader may open, so this panel never adds anything up itself.
 * Scope follows the active project, as the Pages tab does.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Gauge } from 'lucide-vue-next'
import type { QualitySummaryResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { formatRelative } from '@/shared/utils/format'
import { PageState } from '@/shared/layout'
import QualityDistribution from './QualityDistribution.vue'
import QualityHistoryChart from './QualityHistoryChart.vue'
import QualityMeter from './QualityMeter.vue'
import { QUALITY_DIMENSIONS, scoreTone } from '../model/quality-ui'

const props = defineProps<{ workspaceId: string; projectId?: string; scopeLabel: string; canRunAgents: boolean }>()

const { t } = useI18n()

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/quality/summary', {
      query: { workspaceId: props.workspaceId, ...(props.projectId ? { projectId: props.projectId } : {}) },
    }),
  ),
)
const summary = computed(() => query.data.value as QualitySummaryResponse | undefined)
const unscored = computed(() => (summary.value ? summary.value.totalPages - summary.value.scoredPages : 0))
</script>

<template>
  <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-32" />
  <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />

  <div v-else-if="summary && summary.scoredPages === 0" class="max-w-2xl">
    <PageState state="empty" :icon="Gauge" :title="t('quality.empty.title')" :description="t('quality.empty.body')" />
    <p class="mt-2 text-center text-sm">
      <RouterLink v-if="canRunAgents" to="/settings/ai/runs" class="text-primary underline-offset-4 hover:underline">
        {{ t('quality.empty.run') }}
      </RouterLink>
      <span v-else class="text-muted-foreground">{{ t('quality.empty.askAdmin') }}</span>
    </p>
  </div>

  <div v-else-if="summary" class="@container flex min-w-0 flex-col gap-6">
    <!-- The answer in a sentence, then the evidence. -->
    <header class="space-y-1">
      <h2 class="text-base font-semibold">
        <i18n-t keypath="quality.headline" scope="global">
          <template #average>
            <span class="tabular-nums" :class="scoreTone(summary.average, summary.lowThreshold)">{{ summary.average }}</span>
          </template>
          <template #scope>{{ scopeLabel }}</template>
        </i18n-t>
      </h2>
      <p class="text-sm text-muted-foreground">
        {{ t('quality.scored', { scored: summary.scoredPages, total: summary.totalPages }, summary.totalPages) }}
        <template v-if="unscored > 0"> · {{ t('quality.unscored', { n: unscored }, unscored) }}</template>
        <template v-if="summary.lastAuditAt"> · {{ t('quality.lastAudit', { when: formatRelative(summary.lastAuditAt) }) }}</template>
      </p>
    </header>

    <div class="grid min-w-0 gap-6 @4xl:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div class="flex min-w-0 flex-col gap-6">
        <section class="space-y-3" aria-labelledby="quality-history">
          <div>
            <h3 id="quality-history" class="text-sm font-medium">{{ t('quality.history.title') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('quality.history.hint', { threshold: summary.lowThreshold }) }}</p>
          </div>
          <QualityHistoryChart :points="summary.history" :threshold="summary.lowThreshold" />
        </section>

        <section class="space-y-3" aria-labelledby="quality-dimensions">
          <div>
            <h3 id="quality-dimensions" class="text-sm font-medium">{{ t('quality.dimensions.title') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('quality.dimensions.hint') }}</p>
          </div>
          <dl class="@container divide-y rounded-lg border bg-card">
            <div
              v-for="d in QUALITY_DIMENSIONS"
              :key="d"
              class="grid grid-cols-[minmax(0,1fr)_2.5rem] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 @lg:grid-cols-[11rem_minmax(0,1fr)_2.5rem]"
            >
              <dt class="min-w-0">
                <span class="block text-sm">{{ t(`quality.dimension.${d}.label`) }}</span>
                <span class="block text-xs text-muted-foreground">
                  {{
                    summary.dimensions[d].measured
                      ? t('quality.dimensions.measured', { n: summary.dimensions[d].measured }, summary.dimensions[d].measured)
                      : t('quality.dimensions.notMeasured')
                  }}
                </span>
              </dt>
              <dd class="order-last col-span-2 @lg:order-none @lg:col-span-1">
                <QualityMeter
                  :value="summary.dimensions[d].mean"
                  :threshold="summary.lowThreshold"
                  :label="t(`quality.dimension.${d}.label`)"
                />
                <p class="mt-1 text-xs text-muted-foreground">{{ t(`quality.dimension.${d}.hint`) }}</p>
              </dd>
              <dd
                class="text-right text-sm font-medium tabular-nums"
                :class="summary.dimensions[d].mean === null ? 'text-muted-foreground' : scoreTone(summary.dimensions[d].mean, summary.lowThreshold)"
              >
                {{ summary.dimensions[d].mean ?? '—' }}
              </dd>
            </div>
          </dl>
        </section>

        <section class="space-y-3" aria-labelledby="quality-distribution">
          <div>
            <h3 id="quality-distribution" class="text-sm font-medium">{{ t('quality.distribution.title') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('quality.distribution.hint') }}</p>
          </div>
          <QualityDistribution :counts="summary.distribution" :threshold="summary.lowThreshold" class="max-w-md" />
        </section>
      </div>

      <div class="flex min-w-0 flex-col gap-6">
        <section class="space-y-3" aria-labelledby="quality-worst">
          <h3 id="quality-worst" class="text-sm font-medium">{{ t('quality.worst.title') }}</h3>
          <ol class="divide-y rounded-lg border bg-card">
            <li v-for="row in summary.worst" :key="row.documentId">
              <RouterLink
                :to="{ path: `/documents/${row.documentId}`, query: { tab: 'quality' } }"
                class="flex items-center gap-3 px-3 py-2.5 transition-colors outline-none hover:bg-muted/50 focus-visible:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring"
              >
                <span
                  class="w-8 shrink-0 text-right text-sm font-semibold tabular-nums"
                  :class="scoreTone(row.overall, summary.lowThreshold)"
                >{{ row.overall }}</span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm">{{ row.title }}</span>
                  <span class="block truncate text-xs text-muted-foreground">
                    {{ t('quality.issues', { n: row.issueCount }, row.issueCount) }}
                    <template v-if="row.stale"> · {{ t('quality.stale') }}</template>
                  </span>
                </span>
              </RouterLink>
            </li>
          </ol>
        </section>

        <section class="space-y-3" aria-labelledby="quality-rules">
          <div>
            <h3 id="quality-rules" class="text-sm font-medium">{{ t('quality.rules.title') }}</h3>
            <p class="text-xs text-muted-foreground">{{ t('quality.rules.hint') }}</p>
          </div>
          <p v-if="summary.rules.length === 0" class="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
            {{ t('quality.rules.none') }}
          </p>
          <ol v-else class="divide-y rounded-lg border bg-card">
            <li v-for="rule in summary.rules" :key="rule.ruleId" class="space-y-1 px-3 py-2.5">
              <div class="flex items-baseline justify-between gap-3">
                <code class="truncate rounded-sm bg-muted px-1.5 py-0.5 font-mono text-xs">{{ rule.ruleId }}</code>
                <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {{ t('quality.rules.count', { count: rule.count, pages: rule.pages }, rule.pages) }}
                </span>
              </div>
              <p class="line-clamp-2 text-sm" :class="rule.text ? '' : 'text-muted-foreground italic'">
                {{ rule.text ?? t('quality.rules.gone') }}
              </p>
            </li>
          </ol>
          <RouterLink v-if="canRunAgents" to="/settings/ai/styleguide" class="inline-block text-xs text-primary underline-offset-4 hover:underline">
            {{ t('quality.rules.edit') }}
          </RouterLink>
        </section>
      </div>
    </div>
  </div>
</template>
