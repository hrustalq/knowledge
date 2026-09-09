<script setup lang="ts">
// One row per upstream LLM call. Cursor-paginated with the "Load more" footer
// the activity feed uses; pages accumulate so scroll position survives.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import type { AiUsageLogEntry, ListAiUsageLogsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { CircleCheck, CircleX } from 'lucide-vue-next'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()

const OPERATIONS = ['ask', 'chat', 'chat-stream', 'review', 'suggest', 'glossary'] as const
type Operation = (typeof OPERATIONS)[number]
const operation = ref<Operation | ''>('')
const outcome = ref<'' | 'true' | 'false'>('')

const cursor = ref<string | undefined>(undefined)
/** Pages before the current one; the query holds the newest page. */
const older = ref<AiUsageLogEntry[]>([])

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/ai/usage/logs', {
      query: {
        workspaceId,
        ...(cursor.value ? { cursor: cursor.value } : {}),
        ...(operation.value ? { operation: operation.value } : {}),
        ...(outcome.value ? { ok: outcome.value } : {}),
      },
    }),
  ),
)

const page = computed(() => query.data.value as ListAiUsageLogsResponse | undefined)
const entries = computed(() => [...older.value, ...(page.value?.entries ?? [])])

// Changing a filter restarts pagination — otherwise the accumulated pages
// would be a mix of two different filters.
watch([operation, outcome], () => {
  older.value = []
  cursor.value = undefined
})

function loadMore() {
  const next = page.value?.nextCursor
  if (!next) return
  older.value = entries.value
  cursor.value = next
}

function fmtTokens(n: number): string {
  return n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n)
}

/** 8042ms is a number to decode; 8.0s is a duration you feel. */
function fmtDuration(ms: number): string {
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(1)}s` : `${ms}ms`
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <div class="flex flex-wrap gap-1">
        <Button :variant="operation === '' ? 'secondary' : 'ghost'" size="sm" @click="operation = ''">{{ t('common.all') }}</Button>
        <Button
          v-for="op in OPERATIONS"
          :key="op"
          :variant="operation === op ? 'secondary' : 'ghost'"
          size="sm"
          @click="operation = op"
        >
          {{ t(`ai.operationName.${op}`) }}
        </Button>
      </div>
      <div class="flex gap-1">
        <Button :variant="outcome === '' ? 'secondary' : 'ghost'" size="sm" @click="outcome = ''">{{ t('ai.anyOutcome') }}</Button>
        <Button :variant="outcome === 'false' ? 'secondary' : 'ghost'" size="sm" @click="outcome = 'false'">
          {{ t('ai.failedOnly') }}
        </Button>
      </div>
    </div>

    <div v-if="query.isPending.value && entries.length === 0" class="space-y-2">
      <Skeleton v-for="i in 6" :key="i" class="h-9 w-full" />
    </div>

    <p v-else-if="entries.length === 0" class="text-muted-foreground py-10 text-center text-sm">
      {{ t('ai.noCalls') }}
    </p>

    <template v-else>
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead class="w-8"><span class="sr-only">{{ t('ai.outcome') }}</span></TableHead>
              <TableHead>{{ t('ai.when') }}</TableHead>
              <TableHead>{{ t('ai.user') }}</TableHead>
              <TableHead>{{ t('ai.operation') }}</TableHead>
              <TableHead>{{ t('ai.model') }}</TableHead>
              <TableHead class="text-right">{{ t('ai.tokens') }}</TableHead>
              <TableHead class="text-right">{{ t('ai.tools') }}</TableHead>
              <TableHead class="text-right">{{ t('ai.duration') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <template v-for="e in entries" :key="e.id">
            <TableRow>
              <!-- Status leads the row rather than trailing 900px behind it: a
                   failed call is why anyone opens this tab. -->
              <TableCell>
                <CircleCheck v-if="e.ok" class="size-3.5 text-emerald-600" aria-label="ok" />
                <CircleX v-else class="text-destructive size-3.5" aria-label="failed" />
              </TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap" :title="e.createdAt">
                {{ relativeTime(e.createdAt) }}
              </TableCell>
              <TableCell class="max-w-48 truncate">{{ e.userLabel }}</TableCell>
              <TableCell><Badge variant="outline" class="font-normal">{{ e.operation }}</Badge></TableCell>
              <TableCell class="font-mono text-xs">{{ e.model }}</TableCell>
              <TableCell class="text-right tabular-nums">
                {{ fmtTokens(e.totalTokens) }}
                <!-- Some OpenAI-compatible servers report no usage; those rows are estimates. -->
                <span v-if="e.estimated" class="text-muted-foreground" :title="t('ai.estimatedNoUsage')">
                  ~
                </span>
              </TableCell>
              <TableCell class="text-right tabular-nums">{{ e.toolCallCount || '—' }}</TableCell>
              <TableCell class="text-muted-foreground text-right tabular-nums">
                {{ fmtDuration(e.durationMs) }}
              </TableCell>
            </TableRow>
            <!-- The failure reason gets the full row width instead of being
                 truncated to 60 characters inside a cell. -->
            <TableRow v-if="!e.ok && e.error" class="border-0 hover:bg-transparent">
              <TableCell />
              <TableCell colspan="7" class="text-destructive pt-0 text-xs">{{ e.error }}</TableCell>
            </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>

      <div class="text-muted-foreground flex items-center gap-3 px-2 text-xs">
        <span>{{ entries.length }} loaded{{ page?.nextCursor ? '' : ' — end of log' }}</span>
        <Button
          v-if="page?.nextCursor"
          variant="outline"
          size="sm"
          :disabled="query.isFetching.value"
          @click="loadMore"
        >
          {{ query.isFetching.value ? 'Loading…' : 'Load more' }}
        </Button>
      </div>
    </template>
  </div>
</template>
