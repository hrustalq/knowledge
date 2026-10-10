<script setup lang="ts">
// The admin Feedback tab (docs/features/38, phase 5): what people said about
// answers, counted and listed, and the Export that turns it into the
// labelled dataset `make backtest --feedback` replays. Cursor-paginated like
// the Logs tab; pages accumulate so scroll position survives a Load more.
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ANSWER_FEEDBACK_REASONS, ANSWER_SURFACES } from '@knowledge/contracts'
import type {
  AnswerFeedbackListEntry,
  AnswerFeedbackReason,
  AnswerFeedbackSummary,
  AnswerSurface,
  ListAnswerFeedbackResponse,
} from '@knowledge/contracts'
import { Download, MessageSquareWarning, ThumbsDown, ThumbsUp, TriangleAlert, CircleHelp } from 'lucide-vue-next'
import { apiQueryOptions } from '@/api/queries'
import { apiFetchBlob, getWorkspaceId, relativeTime } from '@/lib/api'
import { labelFor } from '@/lib/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()

const KINDS = ['vote', 'low-confidence', 'no-answer'] as const
type Kind = (typeof KINDS)[number]
const kind = ref<Kind | ''>('')
const rating = ref<'' | 'up' | 'down'>('')
const reason = ref<AnswerFeedbackReason | ''>('')
const surface = ref<AnswerSurface | ''>('')

const cursor = ref<string | undefined>(undefined)
/** Pages before the current one; the query holds the newest page. */
const older = ref<AnswerFeedbackListEntry[]>([])

const summaryQuery = useQuery(apiQueryOptions('/v1/ai/feedback/summary', { query: { workspaceId } }))
const summary = computed(() => summaryQuery.data.value as AnswerFeedbackSummary | undefined)
const openReports = computed(() =>
  (summary.value?.issues ?? [])
    .filter((i) => i.status === 'open' || i.status === 'checking' || i.status === 'proposed')
    .reduce((n, i) => n + i.count, 0),
)

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/ai/feedback', {
      query: {
        workspaceId,
        ...(cursor.value ? { cursor: cursor.value } : {}),
        ...(kind.value ? { kind: kind.value } : {}),
        ...(rating.value ? { rating: rating.value } : {}),
        ...(reason.value ? { reason: reason.value } : {}),
        ...(surface.value ? { surface: surface.value } : {}),
      },
    }),
  ),
)
const page = computed(() => query.data.value as ListAnswerFeedbackResponse | undefined)
const entries = computed(() => [...older.value, ...(page.value?.entries ?? [])])

// Changing a filter restarts pagination — otherwise the accumulated pages
// would be a mix of two different filters.
watch([kind, rating, reason, surface], () => {
  older.value = []
  cursor.value = undefined
})

function loadMore() {
  const next = page.value?.nextCursor
  if (!next) return
  older.value = entries.value
  cursor.value = next
}

/** A `Select` has no empty option; the sentinel reads as "any". */
const ANY = '__any__'
function onReason(v: unknown) {
  reason.value = v === ANY || v === null ? '' : (v as AnswerFeedbackReason)
}

const exporting = ref(false)
async function exportDataset() {
  exporting.value = true
  try {
    const { blob, filename } = await apiFetchBlob(`/v1/ai/feedback/export?workspaceId=${encodeURIComponent(workspaceId)}`)
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = filename ?? `feedback-${workspaceId}.ndjson`
    a.click()
    URL.revokeObjectURL(href)
    toast.success(t('ai.feedback.exported'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    exporting.value = false
  }
}

function kindOf(e: AnswerFeedbackListEntry): string {
  if (e.kind !== 'vote') return t(`ai.feedback.kind.${e.kind}`)
  return e.rating === 'up' ? t('assistant.feedback.up') : t('assistant.feedback.down')
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.feedback.subtitle') }}</p>
      <div class="flex items-center gap-2">
        <span v-if="summary" class="text-muted-foreground text-xs">
          {{ t('ai.feedback.datasetVotes', { count: summary.datasetVotes }) }}
        </span>
        <Button v-if="canManage" size="sm" variant="outline" :disabled="exporting" @click="exportDataset">
          <Download class="mr-1.5 size-3.5" />
          {{ exporting ? t('common.loading') : t('ai.feedback.export') }}
        </Button>
      </div>
    </div>

    <!-- Counts over the last 30 days. Derived from the rows below; no table behind them. -->
    <div v-if="summaryQuery.isPending.value" class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <Skeleton v-for="i in 5" :key="i" class="h-16 w-full" />
    </div>
    <dl v-else-if="summary" class="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <div class="rounded-md border p-3">
        <dt class="text-muted-foreground flex items-center gap-1.5 text-xs"><ThumbsUp class="size-3.5" />{{ t('ai.feedback.stat.up') }}</dt>
        <dd class="text-xl font-semibold tabular-nums">{{ summary.votes.up }}</dd>
      </div>
      <div class="rounded-md border p-3">
        <dt class="text-muted-foreground flex items-center gap-1.5 text-xs"><ThumbsDown class="size-3.5" />{{ t('ai.feedback.stat.down') }}</dt>
        <dd class="text-xl font-semibold tabular-nums">{{ summary.votes.down }}</dd>
      </div>
      <div class="rounded-md border p-3">
        <dt class="text-muted-foreground flex items-center gap-1.5 text-xs"><TriangleAlert class="size-3.5" />{{ t('ai.feedback.stat.lowConfidence') }}</dt>
        <dd class="text-xl font-semibold tabular-nums">{{ summary.signals['low-confidence'] }}</dd>
      </div>
      <div class="rounded-md border p-3">
        <dt class="text-muted-foreground flex items-center gap-1.5 text-xs"><CircleHelp class="size-3.5" />{{ t('ai.feedback.stat.noAnswer') }}</dt>
        <dd class="text-xl font-semibold tabular-nums">{{ summary.signals['no-answer'] }}</dd>
      </div>
      <div class="rounded-md border p-3">
        <dt class="text-muted-foreground flex items-center gap-1.5 text-xs"><MessageSquareWarning class="size-3.5" />{{ t('ai.feedback.stat.openReports') }}</dt>
        <dd class="text-xl font-semibold tabular-nums">{{ openReports }}</dd>
      </div>
    </dl>

    <div class="flex flex-wrap items-center gap-3">
      <div class="flex flex-wrap gap-1">
        <Button :variant="kind === '' ? 'secondary' : 'ghost'" size="sm" @click="kind = ''">{{ t('common.all') }}</Button>
        <Button v-for="k in KINDS" :key="k" :variant="kind === k ? 'secondary' : 'ghost'" size="sm" @click="kind = k">
          {{ t(`ai.feedback.kind.${k}`) }}
        </Button>
      </div>
      <div v-if="kind === '' || kind === 'vote'" class="flex gap-1">
        <Button :variant="rating === 'up' ? 'secondary' : 'ghost'" size="sm" :aria-label="t('assistant.feedback.up')" @click="rating = rating === 'up' ? '' : 'up'">
          <ThumbsUp class="size-3.5" />
        </Button>
        <Button :variant="rating === 'down' ? 'secondary' : 'ghost'" size="sm" :aria-label="t('assistant.feedback.down')" @click="rating = rating === 'down' ? '' : 'down'">
          <ThumbsDown class="size-3.5" />
        </Button>
      </div>
      <Select v-if="kind === '' || kind === 'vote'" :model-value="reason || ANY" @update:model-value="onReason">
        <SelectTrigger class="h-8 w-44 text-xs"><SelectValue :placeholder="t('ai.feedback.anyReason')" /></SelectTrigger>
        <SelectContent>
          <SelectItem :value="ANY">{{ t('ai.feedback.anyReason') }}</SelectItem>
          <SelectItem v-for="r in ANSWER_FEEDBACK_REASONS" :key="r" :value="r">{{ labelFor(t, 'assistant.feedback.reason', r) }}</SelectItem>
        </SelectContent>
      </Select>
      <div class="flex flex-wrap gap-1">
        <Button :variant="surface === '' ? 'secondary' : 'ghost'" size="sm" @click="surface = ''">{{ t('ai.feedback.anySurface') }}</Button>
        <Button v-for="s in ANSWER_SURFACES" :key="s" :variant="surface === s ? 'secondary' : 'ghost'" size="sm" @click="surface = s">
          {{ labelFor(t, 'ai.coverage.surface', s) }}
        </Button>
      </div>
    </div>

    <div v-if="query.isPending.value && entries.length === 0" class="space-y-2">
      <Skeleton v-for="i in 6" :key="i" class="h-9 w-full" />
    </div>

    <AiEmptyState v-else-if="entries.length === 0" :icon="ThumbsUp" :title="t('ai.feedback.emptyTitle')" :body="t('ai.feedback.emptyBody')" />

    <template v-else>
      <div class="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{{ t('ai.when') }}</TableHead>
              <TableHead>{{ t('ai.feedback.col.what') }}</TableHead>
              <TableHead>{{ t('ai.feedback.col.question') }}</TableHead>
              <TableHead>{{ t('ai.feedback.col.pages') }}</TableHead>
              <TableHead>{{ t('ai.feedback.col.surface') }}</TableHead>
              <TableHead>{{ t('ai.feedback.col.confidence') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <template v-for="e in entries" :key="e.id">
              <TableRow>
                <TableCell class="text-muted-foreground whitespace-nowrap align-top" :title="e.createdAt">
                  {{ relativeTime(e.createdAt) }}
                </TableCell>
                <TableCell class="whitespace-nowrap align-top">
                  <span class="inline-flex items-center gap-1.5">
                    <ThumbsUp v-if="e.kind === 'vote' && e.rating === 'up'" class="size-3.5 text-emerald-600" />
                    <ThumbsDown v-else-if="e.kind === 'vote'" class="text-destructive size-3.5" />
                    <TriangleAlert v-else-if="e.kind === 'low-confidence'" class="size-3.5 text-amber-600" />
                    <CircleHelp v-else class="text-muted-foreground size-3.5" />
                    <span>{{ kindOf(e) }}</span>
                  </span>
                  <Badge v-if="e.reason" variant="outline" class="ml-1.5 font-normal">{{ labelFor(t, 'assistant.feedback.reason', e.reason) }}</Badge>
                </TableCell>
                <TableCell class="max-w-md align-top">
                  <p class="line-clamp-2" :title="e.query">{{ e.query || '—' }}</p>
                </TableCell>
                <TableCell class="max-w-xs align-top">
                  <div v-if="e.citedDocuments.length" class="flex flex-wrap gap-1">
                    <RouterLink
                      v-for="d in e.citedDocuments"
                      :key="d.id"
                      :to="`/documents/${d.id}`"
                      class="bg-muted hover:bg-accent max-w-40 truncate rounded px-1.5 py-0.5 text-xs"
                      :title="d.title ?? d.id"
                    >
                      {{ d.title ?? t('ai.feedback.deletedPage') }}
                    </RouterLink>
                  </div>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
                <TableCell class="whitespace-nowrap align-top">
                  <Badge variant="outline" class="font-normal">{{ labelFor(t, 'ai.coverage.surface', e.surface) }}</Badge>
                </TableCell>
                <TableCell class="whitespace-nowrap align-top">
                  <span v-if="e.confidence" :title="t('assistant.confidence.title')">{{ labelFor(t, 'assistant.confidence', e.confidence.level) }}</span>
                  <span v-else class="text-muted-foreground">—</span>
                </TableCell>
              </TableRow>
              <!-- The comment gets the full row width instead of a truncated cell. -->
              <TableRow v-if="e.comment" class="border-0 hover:bg-transparent">
                <TableCell />
                <TableCell colspan="5" class="text-muted-foreground pt-0 text-xs italic">{{ e.comment }}</TableCell>
              </TableRow>
            </template>
          </TableBody>
        </Table>
      </div>

      <div class="text-muted-foreground flex items-center gap-3 px-2 text-xs">
        <span>{{ t(page?.nextCursor ? 'common.loadedN' : 'common.loadedEndOfLog', { n: entries.length }) }}</span>
        <Button v-if="page?.nextCursor" variant="outline" size="sm" :disabled="query.isFetching.value" @click="loadMore">
          {{ query.isFetching.value ? t('common.loading') : t('common.loadMore') }}
        </Button>
      </div>
    </template>
  </div>
</template>
