<script setup lang="ts">
/**
 * /qa (#483, phase 4): which operations are ready to test, and the fixtures
 * that set them up. Two tabs, each one list.
 *
 * **Operations** — every HTTP operation at the head of each OpenAPI spec, worst
 * first, with the state the suite panel would show: a fixture needing review,
 * no suite, an outdated one (the cache key moved: the operation, its bound
 * fixtures or the tester changed), setup the spec asks for that nothing is
 * bound to, or ready. The API computes the state with the panel's own key, so
 * the two never disagree; the strip filters the rows in hand, since the
 * response is every row.
 *
 * **Fixtures** — the library. It follows the active project, except when it is
 * narrowed to one operation or one spec: "who calls this" crosses projects,
 * and the counts on the operations tab count every fixture the reader may open.
 *
 * **Environments** (phase 5) — where a server run sends and with what; see
 * QaEnvironments. While the server runner applies, the operations list gains
 * each suite's last server run.
 *
 * `?tab=`, `?status=`, `?op=` and `?spec=` are opening instructions, written
 * back with `replace`, so a row's fixture count is a plain link.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { AlertTriangle, CheckCircle2, FlaskConical, Loader2, Plus, TestTubes, X, XCircle } from 'lucide-vue-next'
import {
  QA_SUITE_STATUSES,
  type ListTestFixturesResponse,
  type QaOperationRow,
  type QaOverviewResponse,
  type QaSuiteStatus,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getProjectId, getWorkspaceId } from '@/shared/api/api'
import { formatNumber, formatRelative } from '@/shared/utils/format'
import type { ApiTone } from '@/modules/api-reference/model/api-spec'
import { Button } from '@/shared/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageLayout, PageState, PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/widgets/page'
import ApiEndpoint from '@/modules/api-reference/components/ApiEndpoint.vue'
import { operationHref } from '@/modules/api-reference/model/use-operation'
import QaEnvironments from '@/modules/api-reference/components/QaEnvironments.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()

const workspaceId = getWorkspaceId()
const projectId = getProjectId() ?? undefined

type TabKey = 'operations' | 'fixtures' | 'environments'
const tabs = computed<PageTab<TabKey>[]>(() => [
  { key: 'operations', label: t('qa.tab.operations') },
  { key: 'fixtures', label: t('qa.tab.fixtures') },
  { key: 'environments', label: t('qa.tab.environments') },
])
const tab = usePageTabs(tabs, 'operations')

/** One `?name=` opening instruction; null clears it. */
function param(name: string) {
  return computed<string | null>({
    get: () => (typeof route.query[name] === 'string' ? (route.query[name] as string) : null),
    set(next) {
      const query = { ...route.query }
      if (next === null) delete query[name]
      else query[name] = next
      void router.replace({ query })
    },
  })
}

/* ------------------------------------------------------------ operations */

const overviewQuery = useQuery(apiQueryOptions('/v1/qa/overview', { query: { workspaceId, ...(projectId ? { projectId } : {}) } }))
const overview = computed(() => overviewQuery.data.value as QaOverviewResponse | undefined)
const rows = computed(() => overview.value?.operations ?? [])

const statusParam = param('status')
const status = computed<QaSuiteStatus | 'all'>({
  get: () => ((QA_SUITE_STATUSES as readonly string[]).includes(statusParam.value ?? '') ? (statusParam.value as QaSuiteStatus) : 'all'),
  set: (next) => (statusParam.value = next === 'all' ? null : next),
})
const shown = computed(() => (status.value === 'all' ? rows.value : rows.value.filter((r) => r.status === status.value)))
const countFor = (s: QaSuiteStatus | 'all') => (s === 'all' ? rows.value : rows.value.filter((r) => r.status === s)).length

/** One hue per state; `none` stays neutral — nothing is wrong yet, there is just nothing. */
const TONE: Record<QaSuiteStatus, ApiTone | null> = {
  review: 'caution',
  unbound: 'warning',
  outdated: 'important',
  none: null,
  ready: 'tip',
}
const toneStyle = (s: QaSuiteStatus) => ({ '--tone': TONE[s] ? `var(--kn-panel-${TONE[s]})` : 'var(--muted-foreground)' })

const fixturesLink = (r: QaOperationRow) => ({ query: { tab: 'fixtures', op: r.entityKey } })
const runner = computed(() => overview.value?.runner ?? false)
const RUN_ICON = { passed: CheckCircle2, failed: XCircle, error: AlertTriangle, queued: Loader2, running: Loader2 } as const

/* -------------------------------------------------------------- fixtures */

const op = param('op')
const spec = param('spec')
const narrowed = computed(() => Boolean(op.value || spec.value))

const fixturesQuery = useQuery(
  computed(() =>
    apiQueryOptions('/v1/test-fixtures', {
      query: {
        workspaceId,
        ...(narrowed.value ? {} : projectId ? { projectId } : {}),
        ...(op.value ? { entityKey: op.value } : {}),
        ...(spec.value ? { specDocumentId: spec.value } : {}),
      },
    }),
  ),
)
const fixtures = computed(() => (fixturesQuery.data.value as ListTestFixturesResponse | undefined)?.fixtures ?? [])

/** Operations by key, from the overview: a fixture names what it calls by key, the reader wants the endpoint. */
const byKey = computed(() => new Map(rows.value.map((r) => [r.entityKey, r])))
const specs = computed(() => [...new Map(rows.value.map((r) => [r.documentId, r.specTitle])).entries()].map(([id, title]) => ({ id, title })))
const opRow = computed(() => (op.value ? (byKey.value.get(op.value) ?? null) : null))

/** The select cannot carry null; this sentinel is "any spec". */
const ANY = 'any'
function setSpec(value: unknown) {
  if (typeof value === 'string') spec.value = value === ANY ? null : value
}

const CALLS_SHOWN = 3
</script>

<template>
  <PageLayout variant="list" :title="t('qa.title')" :subtitle="t('qa.subtitle')">
    <template #actions>
      <Button as-child size="sm" variant="outline">
        <RouterLink to="/create/fixture"><Plus class="size-3.5" /> {{ t('qa.newFixture') }}</RouterLink>
      </Button>
    </template>
    <template #tabs>
      <PageTabs v-model="tab" :tabs="tabs" :label="t('qa.title')" />
    </template>

    <!-- ===================================================== operations -->
    <div v-if="tab === 'operations'" :id="panelId('operations')" role="tabpanel" :aria-labelledby="tabId('operations')" class="flex min-w-0 flex-col gap-4">
      <PageState v-if="overviewQuery.isPending.value" state="loading" :rows="6" row-class="h-12" />
      <PageState v-else-if="overviewQuery.isError.value" state="error" :error="overviewQuery.error.value" />
      <PageState
        v-else-if="!overview?.specs"
        state="empty"
        :icon="FlaskConical"
        :title="t('qa.empty.noSpecs')"
        :description="t('qa.empty.noSpecsHint')"
      >
        <template #actions>
          <Button as-child size="sm" variant="outline"><RouterLink to="/create/spec">{{ t('qa.empty.addSpec') }}</RouterLink></Button>
        </template>
      </PageState>
      <PageState v-else-if="!rows.length" state="empty" :icon="FlaskConical" :title="t('qa.empty.noOperations')" :description="t('qa.empty.noOperationsHint')" />

      <template v-else>
        <!-- The strip is the summary: each state with its count. -->
        <div class="flex flex-wrap gap-1.5" role="group" :aria-label="t('qa.statusFilter')">
          <button
            v-for="s in ['all', ...QA_SUITE_STATUSES] as const"
            :key="s"
            type="button"
            class="inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
            :class="status === s ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'"
            :aria-pressed="status === s"
            :title="s === 'all' ? undefined : t(`qa.statusHint.${s}`)"
            @click="status = s"
          >
            <span v-if="s !== 'all'" class="qa-dot" :style="toneStyle(s)" aria-hidden="true" />
            {{ s === 'all' ? t('qa.all') : t(`qa.status.${s}`) }}
            <span class="tabular-nums opacity-70">{{ formatNumber(countFor(s)) }}</span>
          </button>
        </div>

        <PageState v-if="!shown.length" state="empty" :icon="TestTubes" :title="t('qa.empty.noneWithStatus', { status: t(`qa.status.${status}`) })">
          <template #actions>
            <Button size="sm" variant="outline" @click="status = 'all'">{{ t('qa.showAll') }}</Button>
          </template>
        </PageState>

        <div v-else class="rounded-md border">
          <div class="qa-grid qa-head text-caption text-muted-foreground border-b px-3 py-2 font-medium" :data-runner="runner || undefined" aria-hidden="true">
            <span>{{ t('qa.column.operation') }}</span>
            <span>{{ t('qa.column.status') }}</span>
            <span class="text-right">{{ t('qa.column.cases') }}</span>
            <span>{{ t('qa.column.setup') }}</span>
            <span class="text-right">{{ t('qa.column.fixtures') }}</span>
            <span v-if="runner">{{ t('qa.column.lastRun') }}</span>
          </div>
          <ul class="divide-y">
            <li v-for="r in shown" :key="`${r.documentId}:${r.entityKey}`" class="qa-grid px-3 py-2.5" :data-runner="runner || undefined">
              <div class="min-w-0">
                <RouterLink
                  :to="operationHref(r)"
                  class="group/op block min-w-0 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ApiEndpoint :method="r.method" :path="r.path" protocol="http" />
                  <span class="text-caption text-muted-foreground block truncate pl-[3.875rem] group-hover/op:text-primary">
                    {{ r.summary ? `${r.summary} · ` : '' }}{{ r.specTitle }}{{ r.deprecated ? ` · ${t('qa.deprecated')}` : '' }}
                  </span>
                </RouterLink>
              </div>

              <div class="qa-meta">
                <span class="inline-flex items-center gap-1.5 text-xs font-medium" :title="t(`qa.statusHint.${r.status}`)">
                  <span class="qa-dot" :style="toneStyle(r.status)" aria-hidden="true" />
                  {{ t(`qa.status.${r.status}`) }}
                </span>
              </div>

              <div class="qa-meta text-ui tabular-nums md:text-right">
                <span class="text-muted-foreground md:hidden">{{ t('qa.column.cases') }}: </span>
                <template v-if="r.suite.cases !== null">{{ formatNumber(r.suite.cases) }}</template>
                <span v-else class="text-muted-foreground" :title="t(`qa.suite.${r.suite.state}`)">—</span>
              </div>

              <div class="qa-meta text-ui min-w-0">
                <span class="text-muted-foreground md:hidden">{{ t('qa.column.setup') }}: </span>
                <span v-if="r.reviewFixtures" class="qa-ink-caution inline-flex items-center gap-1">
                  <AlertTriangle class="size-3 shrink-0" aria-hidden="true" />
                  {{ t('qa.setup.review', { n: r.reviewFixtures }, r.reviewFixtures) }}
                </span>
                <template v-else-if="r.bound.suite || r.bound.cases">
                  {{ t('qa.setup.bound', { n: r.bound.suite }, r.bound.suite) }}<span v-if="r.bound.cases" class="text-muted-foreground"> · {{ t('qa.setup.perCase', { n: r.bound.cases }, r.bound.cases) }}</span>
                </template>
                <span v-else-if="r.prerequisites" class="qa-ink-warning">{{ t('qa.setup.needs', { n: r.prerequisites }, r.prerequisites) }}</span>
                <span v-else class="text-muted-foreground">{{ t('qa.setup.none') }}</span>
              </div>

              <div class="qa-meta text-ui tabular-nums md:text-right">
                <RouterLink
                  v-if="r.fixtures"
                  :to="fixturesLink(r)"
                  class="rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  :aria-label="t('qa.fixturesFor', { n: r.fixtures, op: `${r.method} ${r.path}` }, r.fixtures)"
                >
                  <span class="text-muted-foreground md:hidden">{{ t('qa.column.fixtures') }}: </span>{{ formatNumber(r.fixtures) }}
                </RouterLink>
                <span v-else class="text-muted-foreground"><span class="md:hidden">{{ t('qa.column.fixtures') }}: </span>0</span>
              </div>

              <div v-if="runner" class="qa-meta text-ui min-w-0">
                <span class="text-muted-foreground md:hidden">{{ t('qa.column.lastRun') }}: </span>
                <span v-if="r.lastRun" class="inline-flex items-center gap-1" :class="`qa-run--${r.lastRun.status}`">
                  <component
                    :is="RUN_ICON[r.lastRun.status]"
                    class="size-3.5 shrink-0"
                    :class="(r.lastRun.status === 'queued' || r.lastRun.status === 'running') && 'animate-spin motion-reduce:animate-none'"
                    aria-hidden="true"
                  />
                  <template v-if="r.lastRun.status === 'passed' || r.lastRun.status === 'failed'">
                    {{ t('qa.run.counts', { passed: r.lastRun.counts.passed, total: r.lastRun.counts.passed + r.lastRun.counts.failed + r.lastRun.counts.notRun }) }}
                  </template>
                  <template v-else>{{ t(`apiTests.run.serverStatus.${r.lastRun.status}`) }}</template>
                  <span v-if="r.lastRun.finishedAt" class="text-muted-foreground"> · {{ formatRelative(r.lastRun.finishedAt) }}</span>
                </span>
                <span v-else class="text-muted-foreground">—</span>
              </div>
            </li>
          </ul>
        </div>
      </template>
    </div>

    <!-- =================================================== environments -->
    <div v-else-if="tab === 'environments'" :id="panelId('environments')" role="tabpanel" :aria-labelledby="tabId('environments')">
      <QaEnvironments :workspace-id="workspaceId" :runner-on="runner" />
    </div>

    <!-- ======================================================= fixtures -->
    <div v-else :id="panelId('fixtures')" role="tabpanel" :aria-labelledby="tabId('fixtures')" class="flex min-w-0 flex-col gap-4">
      <div class="flex flex-wrap items-center gap-2">
        <Select :model-value="spec ?? ANY" @update:model-value="setSpec">
          <SelectTrigger class="h-9 w-full max-w-64 sm:w-64" :aria-label="t('qa.specFilter')">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="ANY">{{ t('qa.anySpec') }}</SelectItem>
            <SelectItem v-for="s in specs" :key="s.id" :value="s.id">{{ s.title }}</SelectItem>
          </SelectContent>
        </Select>
        <span v-if="op" class="bg-card inline-flex h-9 max-w-full min-w-0 items-center gap-2 rounded-md border pr-1 pl-2.5">
          <span class="text-caption text-muted-foreground shrink-0">{{ t('qa.calls') }}</span>
          <ApiEndpoint v-if="opRow" :method="opRow.method" :path="opRow.path" protocol="http" class="min-w-0" />
          <code v-else class="text-ui min-w-0 truncate font-mono">{{ op }}</code>
          <Button variant="ghost" size="icon" class="size-7 shrink-0" :aria-label="t('qa.clearOperation')" @click="op = null">
            <X class="size-3.5" />
          </Button>
        </span>
      </div>

      <PageState v-if="fixturesQuery.isPending.value" state="loading" :rows="4" row-class="h-12" />
      <PageState v-else-if="fixturesQuery.isError.value" state="error" :error="fixturesQuery.error.value" />
      <PageState
        v-else-if="!fixtures.length"
        state="empty"
        :icon="TestTubes"
        :title="narrowed ? t('qa.empty.noFixturesNarrowed') : t('qa.empty.noFixtures')"
        :description="narrowed ? undefined : t('qa.empty.noFixturesHint')"
      >
        <template #actions>
          <Button v-if="narrowed" size="sm" variant="outline" @click="router.replace({ query: { tab: 'fixtures' } })">{{ t('qa.clearFilters') }}</Button>
          <Button v-else as-child size="sm" variant="outline"><RouterLink to="/create/fixture">{{ t('qa.newFixture') }}</RouterLink></Button>
        </template>
      </PageState>

      <ul v-else class="divide-y rounded-md border">
        <li v-for="f in fixtures" :key="f.documentId" class="flex min-w-0 flex-col gap-1.5 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
          <div class="min-w-0 flex-1">
            <RouterLink :to="`/documents/${f.documentId}`" class="text-sm font-medium [overflow-wrap:anywhere] hover:underline">{{ f.title }}</RouterLink>
            <ul class="mt-1 flex min-w-0 flex-col gap-0.5" :aria-label="t('qa.calls')">
              <li v-for="key in f.calls.slice(0, CALLS_SHOWN)" :key="key" class="min-w-0">
                <ApiEndpoint v-if="byKey.get(key)" :method="byKey.get(key)!.method" :path="byKey.get(key)!.path" protocol="http" />
                <code v-else class="text-caption text-muted-foreground font-mono [overflow-wrap:anywhere]">{{ key }}</code>
              </li>
              <li v-if="f.calls.length > CALLS_SHOWN" class="text-caption text-muted-foreground">
                {{ t('qa.moreCalls', { n: f.calls.length - CALLS_SHOWN }, f.calls.length - CALLS_SHOWN) }}
              </li>
              <li v-if="!f.calls.length" class="text-caption text-muted-foreground">{{ t('qa.manualOnly') }}</li>
            </ul>
          </div>
          <div class="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 sm:flex-col sm:items-end">
            <span v-if="f.brokenCalls.length" class="qa-ink-caution text-caption inline-flex items-center gap-1" :title="f.brokenCalls.join('\n')">
              <AlertTriangle class="size-3 shrink-0" aria-hidden="true" />
              {{ t('qa.brokenCalls', { n: f.brokenCalls.length }, f.brokenCalls.length) }}
            </span>
            <span class="text-caption text-muted-foreground">{{ t('qa.updated', { when: formatRelative(f.updatedAt) }) }}</span>
          </div>
        </li>
      </ul>
    </div>
  </PageLayout>
</template>

<style scoped>
/* One row, two shapes: stacked under md (endpoint, then the facts on one
   wrapping line), five columns from md. */
.qa-grid {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  column-gap: 1rem;
  row-gap: 0.375rem;
}
.qa-grid > :first-child {
  flex-basis: 100%;
}
/* Stacked rows label each fact inline, so the column header is wide-only. */
.qa-head {
  display: none;
}
@media (min-width: 48rem) {
  .qa-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 9rem 4rem minmax(9rem, 13rem) 5rem;
  }
  .qa-grid[data-runner] {
    grid-template-columns: minmax(0, 1fr) 9rem 4rem minmax(9rem, 13rem) 5rem 10rem;
  }
}
.qa-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background: var(--tone);
  flex-shrink: 0;
}
/* The panel hues pulled toward the ink, as ApiTone does, so text holds AA. */
.qa-ink-caution {
  color: color-mix(in oklab, var(--kn-panel-caution) 70%, var(--foreground));
}
.qa-run--passed {
  color: color-mix(in oklab, var(--kn-panel-tip) 70%, var(--foreground));
}
.qa-run--failed,
.qa-run--error {
  color: color-mix(in oklab, var(--kn-panel-caution) 70%, var(--foreground));
}
.qa-ink-warning {
  color: color-mix(in oklab, var(--kn-panel-warning) 70%, var(--foreground));
}
</style>
