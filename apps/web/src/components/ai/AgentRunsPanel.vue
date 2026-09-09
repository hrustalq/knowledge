<script setup lang="ts">
// Background agent runs (docs/features/20). A run proposes; it never writes, so
// this view is a reading surface — findings with the pages they came from.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { CircleAlert, CircleCheck, Clock, Loader2, TriangleAlert } from 'lucide-vue-next'
import type { AgentFinding, AgentRunSummary, ListAgentRunsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

const workspaceId = getWorkspaceId()
const query = useQuery(apiQueryOptions('/v1/ai/agents/runs', { query: { workspaceId } }))
const runs = computed<AgentRunSummary[]>(
  () => (query.data.value as ListAgentRunsResponse | undefined)?.runs ?? [],
)
const counts = computed(() => (query.data.value as ListAgentRunsResponse | undefined)?.counts)

const expanded = ref<string | null>(null)
function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}

const STATUS_ICON = {
  pending: Clock,
  running: Loader2,
  succeeded: CircleCheck,
  failed: CircleAlert,
  cancelled: CircleAlert,
} as const

const SEVERITY_ICON = { info: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const
const severityClass = (f: AgentFinding) =>
  f.severity === 'error' ? 'text-destructive' : f.severity === 'warning' ? 'text-amber-600' : 'text-muted-foreground'
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
        <button class="flex w-full items-start gap-3 p-3 text-left" @click="toggle(run.id)">
          <component
            :is="STATUS_ICON[run.status]"
            class="mt-0.5 size-4 shrink-0"
            :class="[
              run.status === 'failed' && 'text-destructive',
              run.status === 'succeeded' && 'text-emerald-600',
              run.status === 'running' && 'animate-spin',
            ]"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ run.agentName }}</span>
              <Badge variant="secondary" class="font-normal">{{ t(`ai.runs.trigger.${run.trigger}`) }}</Badge>
              <span v-if="run.findingCount" class="text-muted-foreground text-xs">
                {{ t('ai.runs.findings', { count: run.findingCount }) }}
              </span>
            </span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              {{ run.summary || run.error || t('ai.runs.noSummary') }}
            </span>
          </span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ relativeTime(run.createdAt) }}</span>
        </button>

        <ul v-if="expanded === run.id && run.findings.length" class="space-y-2 border-t px-3 py-3">
          <li v-for="(f, i) in run.findings" :key="i" class="flex gap-2.5">
            <component :is="SEVERITY_ICON[f.severity]" class="mt-0.5 size-3.5 shrink-0" :class="severityClass(f)" />
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ f.title }}</p>
              <p class="text-muted-foreground text-xs leading-relaxed">{{ f.detail }}</p>
              <!-- The citation is the point: a finding that names no page is
                   dropped server-side, so every one of these resolves. -->
              <p class="mt-1 flex flex-wrap gap-1">
                <RouterLink
                  v-for="(id, n) in f.documentIds"
                  :key="id"
                  :to="`/documents/${id}`"
                  class="text-primary text-[11px] hover:underline"
                >
                  {{ f.documentTitles[n] ?? id }}
                </RouterLink>
              </p>
            </div>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>
