<script setup lang="ts">
// Background agent runs (docs/features/20). A run proposes; it never writes.
// Each row expands to its findings and their verbs (AgentRunFindings) and
// links to the run's own page (#1247), where its step log lives.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { ArrowRight, Clock, TriangleAlert } from 'lucide-vue-next'
import type { AgentRunSummary, ListAgentRunsResponse, ListConnectorsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { relativeTime } from '@/shared/api/api'
import { Badge } from '@knowledge/ui/badge'
import { Skeleton } from '@knowledge/ui/skeleton'
import { labelFor } from '@/shared/i18n/labels'
import { AiEmptyState } from '@knowledge/ui/empty-state'
import AgentRunFindings from './AgentRunFindings.vue'
import { RUN_STATUS_ICON, isLiveRun, runStatusClass } from '../model/agent-run-ui'

const { t } = useI18n()

const workspaceId = getWorkspaceId()
const query = useQuery({
  ...apiQueryOptions('/v1/ai/agents/runs', { query: { workspaceId } }),
  // A run writes its stage as it goes (docs/features/29), which is only worth
  // anything if the page asks again. Polled while something is in flight and
  // not otherwise: a finished list is finished, and a background tab of settled
  // runs should not be re-fetching every five seconds forever.
  refetchInterval: (q) => {
    const runs = (q.state.data as ListAgentRunsResponse | undefined)?.runs ?? []
    return runs.some((r) => isLiveRun(r.status)) ? 5_000 : false
  },
})
const runs = computed<AgentRunSummary[]>(
  () => (query.data.value as ListAgentRunsResponse | undefined)?.runs ?? [],
)
const counts = computed(() => (query.data.value as ListAgentRunsResponse | undefined)?.counts)

/**
 * Which repository a run read (docs/features/31), by name. The run row carries
 * only the connector id; the connectors list is one query the settings page
 * already makes, and an id nobody can read is not a label.
 */
const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const repositoryName = (run: AgentRunSummary): string | null => {
  const id = run.input?.connectorId
  if (!id) return null
  const rows = (connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? []
  return rows.find((c) => c.id === id)?.name ?? null
}

const expanded = ref<string | null>(null)
function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.runs.subtitle') }}</p>
      <div v-if="counts" class="flex flex-wrap gap-1.5">
        <Badge v-for="(n, status) in counts" :key="status" variant="outline" class="font-normal">
          {{ t(`ai.runs.status.${status}`) }} {{ n }}
        </Badge>
      </div>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <AiEmptyState
      v-else-if="runs.length === 0"
      :icon="Clock"
      :title="t('ai.runs.emptyTitle')"
      :body="t('ai.runs.emptyBody')"
    />

    <ul v-else class="space-y-2">
      <li v-for="run in runs" :key="run.id" class="rounded-md border">
        <button
          class="flex w-full items-start gap-3 p-3 text-left"
          :aria-expanded="expanded === run.id"
          @click="toggle(run.id)"
        >
          <!-- The status is said, not only drawn: the icon is the one place a
               run's outcome shows in the row. -->
          <component
            :is="RUN_STATUS_ICON[run.status]"
            class="mt-0.5 size-4 shrink-0"
            role="img"
            :aria-label="t(`ai.runs.status.${run.status}`)"
            :class="runStatusClass(run.status)"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ run.agentName }}</span>
              <!-- What started it. An event run names its event (#70) in place
                   of the generic "on event", which said the same thing twice. -->
              <Badge variant="secondary" class="font-normal">
                {{
                  run.input?.event
                    ? t(`ai.triggers.events.${run.input.event.type}`)
                    : t(`ai.runs.trigger.${run.trigger}`)
                }}
              </Badge>
              <Badge v-if="repositoryName(run)" variant="outline" class="font-normal">{{ repositoryName(run) }}</Badge>
              <!-- The change a sentinel run checked (docs/features/35). Text, not
                   a link: this sits inside the row's toggle button, where a link
                   is invalid markup — each finding's source chip links out. -->
              <Badge v-if="run.input?.pullRequest" variant="outline" class="max-w-64 font-normal">
                <span class="truncate">#{{ run.input.pullRequest.number }} {{ run.input.pullRequest.title }}</span>
              </Badge>
              <span v-if="run.findingCount" class="text-muted-foreground text-xs">
                {{ t('ai.runs.findings', { count: run.findingCount }) }}
              </span>
            </span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              {{ run.summary || run.error || t('ai.runs.noSummary') }}
            </span>
            <!-- Why it has not started (#1248): another run is working on the
                 same page, and this one starts when that one settles. -->
            <span v-if="run.status === 'pending' && run.queuedBehind" class="text-muted-foreground text-caption mt-1.5 block">
              {{ t('ai.runs.queuedBehind', { agent: run.queuedBehind.agentName }) }}
            </span>
            <!-- What it is doing, while it is doing it (docs/features/29).
                 Only while it runs: a finished run's last stage is noise next to
                 the summary, which says what it actually did. The stage is free
                 text from the executor, so it resolves through labelFor and
                 falls back to itself rather than rendering a message key. -->
            <span v-if="run.status === 'running' && run.stage" class="mt-1.5 flex items-center gap-2">
              <span class="text-muted-foreground text-caption">{{ labelFor(t, 'ai.runs.stage', run.stage) }}</span>
              <span v-if="run.progress !== null" class="bg-muted h-1 w-20 overflow-hidden rounded-full">
                <span
                  class="bg-primary block h-full rounded-full transition-[width] duration-500"
                  :style="{ width: `${Math.round(run.progress * 100)}%` }"
                />
              </span>
            </span>
          </span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ relativeTime(run.createdAt) }}</span>
        </button>

        <!-- What degraded without failing the run (docs/features/29). On expand
             rather than in the row: it qualifies the findings, and a run that
             warned is still a run that succeeded — putting it in the row would
             read as a failure. -->
        <ul v-if="expanded === run.id && run.warnings.length" class="space-y-1 border-t px-3 py-2">
          <li v-for="(w, i) in run.warnings" :key="i" class="flex gap-2 text-caption text-panel-warning-ink">
            <TriangleAlert class="mt-0.5 size-3 shrink-0" />
            <span>{{ w }}</span>
          </li>
        </ul>

        <!-- The run's own page (#1247): its step log, live while it runs. A
             link of its own, not inside the row's toggle button. -->
        <RouterLink
          v-if="expanded === run.id"
          :to="`/agents/runs/${run.id}`"
          class="text-primary flex items-center gap-1 border-t px-3 py-2 text-caption hover:underline"
        >
          {{ t('ai.runs.openRun') }} <ArrowRight class="size-3" />
        </RouterLink>

        <AgentRunFindings v-if="expanded === run.id" :run="run" />
      </li>
    </ul>
  </div>
</template>
