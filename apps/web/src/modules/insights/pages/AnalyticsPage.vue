<script setup lang="ts">
/**
 * Usage analytics (#79, phase 4): the workspace dashboard, admin-only. Is the
 * knowledge base read, and by whom — people in the app, the assistant on a
 * person's behalf, or agents on their own?
 *
 * Five tabs: **Overview** (headline numbers and the daily views chart),
 * **Pages** (most read, never read, dead), **Search** (top, zero-result and
 * unclicked queries), **Agents** (MCP tools, API keys, the assistant) and
 * **Settings**. `?tab=` is an opening instruction. One toolbar sets the range
 * and the traffic class for every tab that splits by it; Agents is one class
 * per list already, so it takes the range only.
 *
 * Every number is the API's rollup over event rows; only the current tab's
 * query runs. Page lists hold pages the admin may open — the API filters.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import {
  ANALYTICS_TRAFFIC_FILTERS,
  TRAFFIC_CLASSES,
  type AnalyticsAgentsResponse,
  type AnalyticsOverviewResponse,
  type AnalyticsPagesResponse,
  type AnalyticsQueryRow,
  type AnalyticsQuietPage,
  type AnalyticsSearchResponse,
  type AnalyticsTrafficFilter,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { formatDate, formatDuration, formatNumber, formatPercent, formatRelative } from '@/shared/utils/format'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/shared/ui/button'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/shared/layout'
import AnalyticsList, { type AnalyticsListRow } from '@/modules/insights/components/AnalyticsList.vue'
import AnalyticsSettings from '@/modules/insights/components/AnalyticsSettings.vue'
import DailyBars from '@/modules/insights/components/DailyBars.vue'
import { TRAFFIC_BAR, TRAFFIC_SEGMENTS, trafficPoints } from '@/modules/insights/model/traffic'

const { t } = useI18n()
const auth = useAuthStore()
const workspaceId = getWorkspaceId()

type TabKey = 'overview' | 'pages' | 'search' | 'agents' | 'settings'
const tabs = computed<PageTab<TabKey>[]>(() =>
  (['overview', 'pages', 'search', 'agents', 'settings'] as const).map((key) => ({ key, label: t(`analytics.tabs.${key}`) })),
)
const tab = usePageTabs(tabs, 'overview')

const RANGES = [7, 30, 90] as const
const days = ref<number>(30)
const traffic = ref<AnalyticsTrafficFilter>('all')
const splitsByTraffic = computed(() => tab.value !== 'agents')

const params = computed(() => ({ workspaceId, days: days.value, ...(splitsByTraffic.value ? { traffic: traffic.value } : {}) }))

/** One query per tab, run only while its tab is open — and never for someone the API would refuse. */
function tabQuery<P extends '/v1/analytics/overview' | '/v1/analytics/pages' | '/v1/analytics/search' | '/v1/analytics/agents'>(
  path: P,
  key: TabKey,
) {
  return useQuery(
    computed(() => ({
      // The four routes take the same query; the generic cannot prove it per path.
      ...apiQueryOptions(path, { query: params.value } as never),
      enabled: auth.canAdminWorkspace && tab.value === key,
    })),
  )
}
const overviewQuery = tabQuery('/v1/analytics/overview', 'overview')
const pagesQuery = tabQuery('/v1/analytics/pages', 'pages')
const searchQuery = tabQuery('/v1/analytics/search', 'search')
const agentsQuery = tabQuery('/v1/analytics/agents', 'agents')

const overview = computed(() => overviewQuery.data.value as AnalyticsOverviewResponse | undefined)
const pages = computed(() => pagesQuery.data.value as AnalyticsPagesResponse | undefined)
const search = computed(() => searchQuery.data.value as AnalyticsSearchResponse | undefined)
const agents = computed(() => agentsQuery.data.value as AnalyticsAgentsResponse | undefined)
const current = computed(
  () => ({ overview: overviewQuery, pages: pagesQuery, search: searchQuery, agents: agentsQuery })[tab.value as Exclude<TabKey, 'settings'>],
)

/* --------------------------------------------------------------- overview */

/** The headline numbers. A metric the traffic filter leaves out is dropped, not shown as 0. */
const stats = computed(() => {
  const o = overview.value
  if (!o) return []
  const all: Array<{ key: string; value: string } | null> = [
    { key: 'views', value: formatNumber(o.views) },
    { key: 'uniqueReaders', value: formatNumber(o.uniqueReaders) },
    { key: 'medianRead', value: o.medianReadMs === null ? '—' : formatDuration(o.medianReadMs) },
    { key: 'searches', value: formatNumber(o.searches) },
    { key: 'zeroResult', value: o.searches ? formatPercent(o.zeroResultSearches / o.searches) : '—' },
    { key: 'clickThrough', value: o.clickThrough === null ? '—' : formatPercent(o.clickThrough) },
    o.assistantQuestions === null ? null : { key: 'assistantQuestions', value: formatNumber(o.assistantQuestions) },
    o.mcpCalls === null ? null : { key: 'mcpCalls', value: formatNumber(o.mcpCalls) },
  ]
  return all.filter((s): s is { key: string; value: string } => s !== null)
})
const points = computed(() => trafficPoints(overview.value?.series ?? []))

/* ------------------------------------------------------------------ pages */

/** Dead pages need reads counted across their whole window; until then the empty list is not a verdict. */
const deadPending = computed(() => {
  const p = pages.value
  return !!p && (!p.collectingSince || Date.parse(p.collectingSince) > Date.now() - p.deadAfterDays * 86_400_000)
})
const quietRows = (list: AnalyticsQuietPage[]): AnalyticsListRow[] =>
  list.map((p) => ({
    key: p.documentId,
    label: p.title,
    to: `/documents/${p.documentId}`,
    meta: t('analytics.project.createdAgo', { when: formatRelative(p.createdAt) }),
  }))
const topPageRows = computed<AnalyticsListRow[]>(() =>
  (pages.value?.topPages ?? []).map((p) => ({
    key: p.documentId,
    label: p.title,
    to: `/documents/${p.documentId}`,
    meta: [
      t('analytics.viewsCount', { n: formatNumber(p.views) }, p.views),
      t('analytics.readersCount', { n: formatNumber(p.uniqueReaders) }, p.uniqueReaders),
      ...(p.medianReadMs === null ? [] : [formatDuration(p.medianReadMs)]),
    ].join(' · '),
  })),
)

/* ----------------------------------------------------------------- search */

function queryRows(list: AnalyticsQueryRow[], detail: boolean): AnalyticsListRow[] {
  return list.map((q) => ({
    key: q.queryHash,
    label: q.queryText ?? t('analytics.search.redacted', { hash: q.queryHash.slice(0, 8) }),
    muted: q.queryText === null,
    meta: [
      t('analytics.searchesCount', { n: formatNumber(q.searches) }, q.searches),
      ...(detail && q.clickThrough !== null ? [t('analytics.search.ctr', { value: formatPercent(q.clickThrough) })] : []),
      ...(detail && q.meanClickedRank !== null ? [t('analytics.search.rank', { n: q.meanClickedRank })] : []),
    ].join(' · '),
  }))
}

/* ----------------------------------------------------------------- agents */

const toolRows = computed<AnalyticsListRow[]>(() =>
  (agents.value?.tools ?? []).map((r) => ({
    key: r.tool,
    label: r.tool,
    meta: [
      t('analytics.agents.callsCount', { n: formatNumber(r.calls) }, r.calls),
      ...(r.errors ? [t('analytics.agents.errorsCount', { n: formatNumber(r.errors) }, r.errors)] : []),
      ...(r.medianMs === null ? [] : [formatDuration(r.medianMs)]),
    ].join(' · '),
  })),
)
const keyRows = computed<AnalyticsListRow[]>(() =>
  (agents.value?.keys ?? []).map((r) => ({
    key: r.apiKeyId,
    label: r.name ? `${r.name} · ${r.prefix}…` : t('analytics.agents.deletedKey', { id: r.apiKeyId.slice(0, 8) }),
    muted: !r.name,
    meta: [
      t('analytics.agents.callsCount', { n: formatNumber(r.mcpCalls) }, r.mcpCalls),
      t('analytics.viewsCount', { n: formatNumber(r.views) }, r.views),
      t('analytics.searchesCount', { n: formatNumber(r.searches) }, r.searches),
    ].join(' · '),
  })),
)
const operationRows = computed<AnalyticsListRow[]>(() =>
  (agents.value?.operations ?? []).map((r) => ({
    key: r.operation,
    label: r.operation,
    meta: t('analytics.agents.callsCount', { n: formatNumber(r.calls) }, r.calls),
  })),
)
const questionPoints = computed(() => (agents.value?.questionSeries ?? []).map((p) => ({ date: p.date, values: [p.count] })))
</script>

<template>
  <PageLayout variant="list" :title="t('analytics.title')" :subtitle="t('analytics.subtitle')">
    <template #tabs>
      <PageTabs v-if="auth.canAdminWorkspace" v-model="tab" :tabs="tabs" :label="t('analytics.title')" />
    </template>

    <PageState v-if="!auth.canAdminWorkspace" state="forbidden" :description="t('analytics.adminOnly')" />

    <template v-else>
      <div v-if="tab !== 'settings'" class="flex flex-wrap items-center gap-x-5 gap-y-2">
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
        <div v-if="splitsByTraffic" class="flex flex-wrap gap-1" role="group" :aria-label="t('analytics.trafficFilter')">
          <Button
            v-for="f in ANALYTICS_TRAFFIC_FILTERS"
            :key="f"
            :variant="traffic === f ? 'secondary' : 'ghost'"
            size="xs"
            :aria-pressed="traffic === f"
            :title="f === 'all' ? undefined : t(`analytics.trafficHint.${f}`)"
            @click="traffic = f"
          >
            {{ f === 'all' ? t('analytics.trafficAll') : t(`analytics.traffic.${f}`) }}
          </Button>
        </div>
      </div>

      <div v-if="tab === 'settings'" :id="panelId('settings')" role="tabpanel" :aria-labelledby="tabId('settings')">
        <AnalyticsSettings :workspace-id="workspaceId" />
      </div>

      <div v-else :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="mt-5 min-w-0">
        <!-- The panel's lists title themselves h3, as they do under a project's
             h2; the tab is that level here, spoken rather than drawn twice. -->
        <h2 class="sr-only">{{ t(`analytics.tabs.${tab}`) }}</h2>
        <PageState v-if="current.isPending.value" state="loading" :rows="4" row-class="h-14" />
        <PageState v-else-if="current.isError.value" state="error" :error="current.error.value" />

        <!-- Overview -->
        <div v-else-if="tab === 'overview' && overview" class="space-y-6">
          <p v-if="!overview.recording" class="rounded-lg border px-3 py-2 text-sm text-muted-foreground">
            {{ t('analytics.recordingOff') }}
          </p>
          <dl class="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-4">
            <div v-for="s in stats" :key="s.key" class="min-w-0">
              <dt class="truncate text-xs text-muted-foreground" :title="t(`analytics.metrics.${s.key}.hint`)">
                {{ t(`analytics.metrics.${s.key}.label`) }}
              </dt>
              <dd class="text-2xl font-semibold tabular-nums">{{ s.value }}</dd>
            </div>
          </dl>

          <div class="space-y-2 rounded-xl border bg-card p-5">
            <p v-if="!overview.collectingSince" class="text-sm text-muted-foreground">{{ t('analytics.notCollecting') }}</p>
            <template v-else>
              <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <li v-for="c in TRAFFIC_CLASSES" :key="c" class="flex items-center gap-1.5" :title="t(`analytics.trafficHint.${c}`)">
                  <span class="size-2 shrink-0 rounded-[2px]" :class="TRAFFIC_BAR[c]" aria-hidden="true" />
                  <span class="text-muted-foreground">{{ t(`analytics.traffic.${c}`) }}</span>
                  <span class="font-medium tabular-nums">{{ formatNumber(overview.byClass[c]) }}</span>
                </li>
              </ul>
              <DailyBars
                v-if="overview.views > 0"
                :from="overview.from"
                :to="overview.to"
                :points="points"
                :segments="TRAFFIC_SEGMENTS"
                :label="t('analytics.viewsChartLabel', { n: days })"
                :point-title="(date, [human, assisted, agent]) => t('analytics.chartPoint', { date, human, assisted, agent })"
              />
              <p v-else class="text-sm text-muted-foreground">{{ t('analytics.project.noViews') }}</p>
              <p v-if="Date.parse(overview.collectingSince) > Date.parse(overview.from)" class="text-xs text-muted-foreground">
                {{ t('analytics.collectingSince', { when: formatDate(overview.collectingSince) }) }}
              </p>
            </template>
          </div>
        </div>

        <!-- Pages -->
        <div v-else-if="tab === 'pages' && pages" class="space-y-6">
          <AnalyticsList
            :title="t('analytics.project.topPages')"
            :rows="topPageRows"
            :empty="t('analytics.project.noViews')"
            report="pages-top"
            :params="params"
          />
          <div class="grid gap-6 lg:grid-cols-2">
            <AnalyticsList
              :title="t('analytics.project.neverRead')"
              :rows="quietRows(pages.neverRead)"
              :empty="pages.collectingSince ? t('analytics.project.none') : t('analytics.notCollecting')"
              report="pages-never-read"
              :params="params"
            />
            <AnalyticsList
              :title="t('analytics.project.dead')"
              :hint="deadPending ? t('analytics.project.deadNotYet', { n: pages.deadAfterDays }) : t('analytics.project.deadHint', { n: pages.deadAfterDays })"
              :rows="quietRows(pages.dead)"
              :empty="deadPending ? t('analytics.pages.deadPending') : t('analytics.project.none')"
              report="pages-dead"
              :params="params"
            />
          </div>
        </div>

        <!-- Search -->
        <div v-else-if="tab === 'search' && search" class="space-y-6">
          <AnalyticsList
            :title="t('analytics.search.top')"
            :hint="t('analytics.search.topHint')"
            :rows="queryRows(search.top, true)"
            :empty="t('analytics.search.none')"
            report="search-top"
            :params="params"
          />
          <div class="grid gap-6 lg:grid-cols-2">
            <AnalyticsList
              :title="t('analytics.search.zeroResult')"
              :hint="t('analytics.search.zeroResultHint')"
              :rows="queryRows(search.zeroResult, false)"
              :empty="t('analytics.search.noneZero')"
              report="search-zero-result"
              :params="params"
            />
            <AnalyticsList
              :title="t('analytics.search.noClick')"
              :hint="t('analytics.search.noClickHint')"
              :rows="queryRows(search.noClick, false)"
              :empty="t('analytics.project.none')"
              report="search-no-click"
              :params="params"
            />
          </div>
        </div>

        <!-- Agents -->
        <div v-else-if="tab === 'agents' && agents" class="space-y-6">
          <div class="grid gap-6 lg:grid-cols-2">
            <AnalyticsList
              :title="t('analytics.agents.tools')"
              :rows="toolRows"
              :empty="t('analytics.agents.noCalls')"
              report="agents-tools"
              :params="params"
            />
            <AnalyticsList
              :title="t('analytics.agents.keys')"
              :hint="t('analytics.agents.keysHint')"
              :rows="keyRows"
              :empty="t('analytics.agents.noKeys')"
              report="agents-keys"
              :params="params"
            />
          </div>

          <section class="space-y-2 rounded-xl border bg-card p-5" :aria-label="t('analytics.agents.assistant')">
            <div class="flex flex-wrap items-baseline justify-between gap-2">
              <h3 class="text-sm font-medium">{{ t('analytics.agents.assistant') }}</h3>
              <span class="text-xs text-muted-foreground tabular-nums">
                {{ t('analytics.agents.questionsCount', { n: formatNumber(agents.assistantQuestions) }, agents.assistantQuestions) }}
              </span>
            </div>
            <DailyBars
              v-if="agents.assistantQuestions > 0"
              :from="agents.from"
              :to="agents.to"
              :points="questionPoints"
              :segments="[{ class: TRAFFIC_BAR.assisted }]"
              :height="64"
              :label="t('analytics.agents.questionsChartLabel', { n: days })"
              :point-title="(date, [n]) => t('analytics.agents.questionsPoint', { date, n })"
            />
            <p v-else class="text-sm text-muted-foreground">{{ t('analytics.agents.noQuestions') }}</p>
          </section>

          <AnalyticsList
            :title="t('analytics.agents.operations')"
            :hint="t('analytics.agents.operationsHint')"
            :rows="operationRows"
            :empty="t('analytics.agents.noCalls')"
            report="agents-operations"
            :params="params"
          />
        </div>
      </div>
    </template>
  </PageLayout>
</template>
