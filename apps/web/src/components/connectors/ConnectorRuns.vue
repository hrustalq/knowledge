<script setup lang="ts">
// The Runs tab (docs/features/19): every sync execution, newest first, with the
// counts that say what actually happened and the warnings that say what did not.
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { History } from 'lucide-vue-next'
import type { ConnectorRunInfo, ListConnectorRunsResponse, ListConnectorsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { PHASE_LABEL, RUN_STATUS_LABEL } from './connector-ui'

defineProps<{ canManage: boolean }>()

const { t } = useI18n()
const workspaceId = getWorkspaceId()

const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const connectors = computed(() => (connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? [])

const selected = ref('')
// Default to the first connector once the roster arrives, so the tab is never
// an empty picker over a workspace that does have runs.
watch(connectors, (list) => {
  if (!selected.value && list.length) selected.value = list[0].id
}, { immediate: true })

const runsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/{id}/runs', { path: { id: selected.value } }),
    enabled: selected.value !== '',
    // A run in flight advances; this tab is a live view of it.
    refetchInterval: 4000,
  })),
)
const runs = computed(() => (runsQuery.data.value as ListConnectorRunsResponse | undefined)?.runs ?? [])

function statusVariant(status: ConnectorRunInfo['status']) {
  if (status === 'failed') return 'destructive'
  if (status === 'partial') return 'outline'
  return 'secondary'
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <Select v-model="selected">
        <SelectTrigger class="w-64"><SelectValue :placeholder="t('connectors.pickConnector')" /></SelectTrigger>
        <SelectContent>
          <SelectItem v-for="c in connectors" :key="c.id" :value="c.id">{{ c.name }}</SelectItem>
        </SelectContent>
      </Select>
    </div>

    <div v-if="runsQuery.isPending.value && selected" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-16 w-full" />
    </div>

    <AiEmptyState
      v-else-if="!runs.length"
      :icon="History"
      :title="t('connectors.noRunsTitle')"
      :body="t('connectors.noRunsBody')"
    />

    <ul v-else class="space-y-3">
      <li v-for="run in runs" :key="run.id" class="rounded-lg border p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <Badge :variant="statusVariant(run.status)">{{ t(RUN_STATUS_LABEL[run.status]) }}</Badge>
            <span class="text-sm">{{ t(`connectors.direction${run.direction === 'push' ? 'Push' : 'Pull'}`) }}</span>
            <span class="text-muted-foreground text-xs">{{ t(`connectors.trigger.${run.trigger}`) }}</span>
            <!-- Which part of the work it is in — distinct from status, since a
                 run can be paused while discovering (docs/features/26). -->
            <span v-if="run.phase" class="text-muted-foreground text-xs">· {{ t(PHASE_LABEL[run.phase]) }}</span>
            <!-- The one count worth a colour: this run is waiting on a person. -->
            <Badge v-if="run.awaitingReview > 0" variant="outline" class="border-amber-500/40 text-amber-700 dark:text-amber-400">
              {{ t('connectors.awaitingReview', { count: run.awaitingReview }, run.awaitingReview) }}
            </Badge>
          </div>
          <div class="flex items-center gap-3">
            <!-- Every run opens, not just a staged one: the tree is also how you
                 read what a finished run did, and how you revert one page of it. -->
            <RouterLink
              :to="`/settings/connectors/runs/${run.id}`"
              class="text-primary text-xs font-medium hover:underline"
            >
              {{ run.awaitingReview > 0 ? t('connectors.reviewRun') : t('connectors.openRun') }}
            </RouterLink>
            <span class="text-muted-foreground text-xs">{{ relativeTime(run.createdAt) }}</span>
          </div>
        </div>

        <p v-if="run.stage" class="text-muted-foreground mt-2 text-xs">
          {{ run.stage }}
          <template v-if="run.progress !== null"> — {{ Math.round(run.progress * 100) }}%</template>
        </p>

        <!-- Counts are the honest summary of a sync: what it made, what it left. -->
        <dl class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <div v-for="key in (['created', 'updated', 'skipped', 'conflicts', 'failed'] as const)" :key="key" class="flex gap-1">
            <dt class="text-muted-foreground">{{ t(`connectors.count_${key}`) }}</dt>
            <dd :class="key === 'failed' && run.failed > 0 ? 'text-destructive font-medium' : 'font-medium'">
              {{ run[key] }}
            </dd>
          </div>
        </dl>

        <p v-if="run.error" class="text-destructive mt-2 text-xs">{{ run.error.message }}</p>

        <details v-if="run.warnings.length" class="mt-2">
          <summary class="text-muted-foreground cursor-pointer text-xs">
            {{ t('connectors.warningCount', { count: run.warnings.length }, run.warnings.length) }}
          </summary>
          <ul class="mt-1.5 space-y-1">
            <li v-for="(warning, i) in run.warnings" :key="i" class="text-muted-foreground text-xs">
              <span v-if="warning.title" class="font-medium">{{ warning.title }}: </span>{{ warning.message }}
            </li>
          </ul>
        </details>
      </li>
    </ul>
  </div>
</template>
