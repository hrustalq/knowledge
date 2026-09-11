<script setup lang="ts">
/**
 * One sync run, while it happens (docs/features/26).
 *
 * A pull used to be a number that went up and a row that went green. That is
 * adequate for a transfer and wrong for this: a pull from a wiki is an edit to
 * somebody's knowledge base, made by a machine, at a scale nobody reads
 * afterwards. So the run is a place you can stand in — watch the tree fill in,
 * stop it, read what it proposes, fix a page, and approve a branch at a time.
 *
 * LAYOUT. The import wizard's frame, for the import wizard's reason: a fixed
 * header, a body that flexes to fill whatever is left, and one action bar
 * pinned to the bottom. The two panes inside differ enormously in height — a
 * tree of three rows or three hundred, a progress ring, a full editor — and
 * without a fixed frame the run controls would wander down the page every time
 * the worker found something.
 *
 * The action bar carries the *run*'s controls and nothing else. Per-item
 * actions live on the item, in the tree and in the review pane, because they
 * are about one page; Pause and Cancel are about all of them. Which controls
 * are legal comes from `allowedRunEvents`, never from reading `status` here —
 * that shared table is the whole reason the buttons and the transitions the API
 * accepts cannot drift.
 *
 * POLLING. The row is the truth and the client polls it, the feature-16
 * contract. Live events invalidate the same queries (see live-cache), so the
 * poll is the floor rather than the mechanism, and it stops the moment the run
 * reaches a terminal state.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ArrowLeft, FileStack, Loader2 } from 'lucide-vue-next'
import {
  allowedRunEvents,
  type ConnectorItemEventType,
  type ConnectorItemAiOp,
  type ConnectorRunEventType,
  type ConnectorRunInfo,
  type ConnectorRunItemInfo,
  type ConnectorRunItemResponse,
  type ListConnectorRunItemsResponse,
} from '@knowledge/contracts'
import { api } from '@/api/client'
import { apiQueryOptions } from '@/api/queries'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import AiEmptyState from '@/components/ai/AiEmptyState.vue'
import ParseProgress from '@/components/import/ParseProgress.vue'
import ConnectorItemReview from '@/components/connectors/ConnectorItemReview.vue'
import ConnectorRunTree from '@/components/connectors/ConnectorRunTree.vue'
import {
  PHASE_LABEL,
  RUN_EVENT_LABEL,
  RUN_STATUS_CLASS,
  RUN_STATUS_ICON,
  RUN_STATUS_LABEL,
  descendantsOf,
  isRunActive,
} from '@/components/connectors/connector-ui'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const auth = useAuthStore()
const documents = useDocumentsStore()

const runId = computed(() => String(route.params.runId ?? ''))

/** Approving a page writes to the knowledge base, which is an editor's act. */
const canManage = computed(() => auth.canEdit)

// --- the run row, polled while it is still moving -------------------------

/**
 * The poll gate, held apart from the queries on purpose.
 *
 * `refetchInterval` wants to know whether the run is still moving, and the only
 * place that is known is the run query's own data — which is a cycle TypeScript
 * cannot infer through. A plain ref written from a watcher is the way out, and
 * it reads better than the alternative anyway: one flag, two queries, both
 * stopping on the same fact.
 */
const polling = ref(true)

const runQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/runs/{runId}', { path: { runId: runId.value } }),
    enabled: runId.value !== '',
    refetchInterval: polling.value ? 4000 : (false as const),
  })),
)
const run = computed<ConnectorRunInfo | null>(
  () => (runQuery.data.value as { run: ConnectorRunInfo } | undefined)?.run ?? null,
)
watch(run, (r) => {
  polling.value = r === null || isRunActive(r.status)
})

const itemsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/runs/{runId}/items', { path: { runId: runId.value } }),
    enabled: runId.value !== '',
    refetchInterval: polling.value ? 4000 : (false as const),
  })),
)
const itemsData = computed(() => itemsQuery.data.value as ListConnectorRunItemsResponse | undefined)
const items = computed<ConnectorRunItemInfo[]>(() => itemsData.value?.items ?? [])

// --- selection ------------------------------------------------------------

const selectedId = ref<string | null>(null)

/**
 * Land on the first page that wants a person rather than on nothing. A review
 * whose right half is empty until you go looking is a review that starts by
 * asking you to find the work.
 */
watch(items, (list) => {
  if (selectedId.value && list.some((i) => i.id === selectedId.value)) return
  selectedId.value = list.find((i) => i.status === 'staged')?.id ?? null
})

const selected = computed(() => items.value.find((i) => i.id === selectedId.value) ?? null)

const detailQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/connectors/runs/{runId}/items/{itemId}', {
      path: { runId: runId.value, itemId: selectedId.value ?? '' },
    }),
    enabled: runId.value !== '' && selectedId.value !== null,
  })),
)
const detail = computed(() => detailQuery.data.value as ConnectorRunItemResponse | undefined)

// --- the editable copy ----------------------------------------------------

const title = ref('')
const markdown = ref('')
const reviewRef = ref<InstanceType<typeof ConnectorItemReview> | null>(null)
/** True once this item's fields have been typed into and not yet saved. */
const dirty = ref(false)

/**
 * Seed the fields from the server copy exactly once per item — a late poll must
 * not overwrite what the reviewer is typing. The same rule as the import
 * wizard's, and for the same reason, except that here the polling is constant.
 */
watch(detail, (d) => {
  if (!d || d.item.id !== selectedId.value) return
  if (dirty.value) return
  title.value = d.item.title
  markdown.value = d.markdown
})
watch(selectedId, () => {
  dirty.value = false
})
watch([title, markdown], () => {
  if (detail.value && detail.value.item.id === selectedId.value) dirty.value = true
})

// --- acting ---------------------------------------------------------------

const busyIds = ref(new Set<string>())
const runBusy = ref<ConnectorRunEventType | null>(null)
const aiBusy = ref<ConnectorItemAiOp | null>(null)
const saving = ref(false)

function mark(id: string, on: boolean) {
  const next = new Set(busyIds.value)
  if (on) next.add(id)
  else next.delete(id)
  busyIds.value = next
}

/** Both queries, because an item event moves the run's counts too. */
async function refresh() {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ['/v1/connectors/runs/{runId}', { runId: runId.value }] }),
    queryClient.invalidateQueries({ queryKey: ['/v1/connectors/runs/{runId}/items', { runId: runId.value }] }),
  ])
}

/** Never approve stale text: the editor debounces, so flush before saving. */
async function saveEdits(): Promise<void> {
  if (!selected.value || !dirty.value) return
  const body = reviewRef.value?.flush() ?? markdown.value
  saving.value = true
  try {
    await api.patch('/v1/connectors/runs/{runId}/items/{itemId}', {
      path: { runId: runId.value, itemId: selected.value.id },
      body: { title: title.value, markdown: body },
    })
    dirty.value = false
    await refresh()
    await queryClient.invalidateQueries({
      queryKey: ['/v1/connectors/runs/{runId}/items/{itemId}', { runId: runId.value, itemId: selected.value.id }],
    })
  } finally {
    saving.value = false
  }
}

async function itemEvent(payload: { itemId: string; type: ConnectorItemEventType; subtree: boolean }) {
  // Approving the page being edited must approve what is on screen, not the
  // copy the server last heard about.
  if (payload.type === 'APPROVE' && payload.itemId === selectedId.value && dirty.value) {
    try {
      await saveEdits()
    } catch (e) {
      toast.error((e as Error).message)
      return
    }
  }
  mark(payload.itemId, true)
  try {
    await api.post('/v1/connectors/runs/{runId}/items/{itemId}/events', {
      path: { runId: runId.value, itemId: payload.itemId },
      body: { type: payload.type, subtree: payload.subtree },
    })
    if (payload.subtree) {
      const n = descendantsOf(items.value, payload.itemId).length + 1
      toast.success(t('connectors.subtreeDone', { count: n }, n))
    }
    await refresh()
    // A revert deletes or rewrites a page, so the roster the tree and the
    // editor read from is no longer what the server has.
    if (payload.type === 'REVERT' || payload.type === 'APPROVE') void documents.fetchList()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    mark(payload.itemId, false)
  }
}

async function runEvent(type: ConnectorRunEventType) {
  runBusy.value = type
  try {
    await api.post('/v1/connectors/runs/{runId}/events', {
      path: { runId: runId.value },
      body: { type },
    })
    await refresh()
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    runBusy.value = null
  }
}

async function runAi(op: ConnectorItemAiOp) {
  if (!selected.value) return
  // The assist rewrites the staged markdown server-side, so anything typed and
  // unsaved would be silently replaced. Save it first — it is also the text the
  // cleanup should be working from.
  try {
    await saveEdits()
  } catch (e) {
    toast.error((e as Error).message)
    return
  }
  aiBusy.value = op
  const itemId = selected.value.id
  try {
    await api.post('/v1/connectors/runs/{runId}/items/{itemId}/ai', {
      path: { runId: runId.value, itemId },
      body: { op },
    })
    dirty.value = false
    await queryClient.invalidateQueries({
      queryKey: ['/v1/connectors/runs/{runId}/items/{itemId}', { runId: runId.value, itemId }],
    })
    await refresh()
    toast.success(t(`connectors.aiDone.${op}`))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    aiBusy.value = null
  }
}

// --- what the frame shows -------------------------------------------------

const events = computed(() => (run.value && canManage.value ? allowedRunEvents(run.value) : []))

/** Discovery is unbounded; fetching is not. `null` means "the worker knows, I don't". */
const progress = computed(() => {
  const r = run.value
  if (!r) return null
  if (r.phase === 'discovering') return null
  if (r.phase === 'fetching' && r.discovered > 0) {
    const done = items.value.filter((i) => i.status !== 'discovered' && i.status !== 'fetching').length
    return Math.min(1, done / r.discovered)
  }
  return r.progress
})

const stage = computed(() => {
  const r = run.value
  if (!r) return ''
  // The worker's own account first; the phase is the fallback, never a guess.
  return r.stage ?? (r.phase ? t(PHASE_LABEL[r.phase]) : t(RUN_STATUS_LABEL[r.status]))
})

/** Nothing found yet: the ring is the whole story, so it gets the room. */
const showRing = computed(() => items.value.length === 0 && run.value !== null && isRunActive(run.value.status))
</script>

<template>
  <div class="flex h-full flex-col">
    <!-- Fixed frame, part one: which run this is and where it has got to. -->
    <header class="flex shrink-0 flex-wrap items-center justify-between gap-x-6 gap-y-3 border-b px-4 py-3 lg:px-6">
      <div class="flex min-w-0 items-center gap-3">
        <Button variant="ghost" size="sm" @click="router.push('/settings/connectors?tab=runs')">
          <ArrowLeft class="size-4" aria-hidden="true" />
          {{ t('connectors.backToRuns') }}
        </Button>
        <h1 class="truncate text-base font-semibold tracking-tight">{{ t('connectors.runTitle') }}</h1>
      </div>

      <div v-if="run" class="flex flex-wrap items-center gap-2 text-xs">
        <Badge variant="secondary" class="gap-1.5">
          <component
            :is="RUN_STATUS_ICON[run.status]"
            class="size-3.5"
            :class="[RUN_STATUS_CLASS[run.status], run.status === 'running' && 'animate-spin']"
            aria-hidden="true"
          />
          {{ t(RUN_STATUS_LABEL[run.status]) }}
        </Badge>
        <span v-if="run.phase" class="text-muted-foreground">{{ t(PHASE_LABEL[run.phase]) }}</span>
        <span class="text-muted-foreground">·</span>
        <span class="text-muted-foreground">{{ t(`connectors.mode.${run.mode}`) }}</span>
        <span v-if="run.awaitingReview > 0" class="font-medium text-amber-600 dark:text-amber-500">
          {{ t('connectors.awaitingReview', { count: run.awaitingReview }, run.awaitingReview) }}
        </span>
      </div>
    </header>

    <!-- The body owns whatever height is left; each pane scrolls its own. -->
    <div class="flex min-h-0 flex-1 overflow-hidden">
      <div v-if="runQuery.isPending.value" class="flex-1 space-y-2 p-4">
        <Skeleton v-for="i in 5" :key="i" class="h-10 w-full" />
      </div>

      <!-- Nothing found yet. The ring already knows how to say "the worker owns
           this half and will not invent a number" — which is discovery exactly. -->
      <div v-else-if="showRing" class="grid flex-1 place-items-center px-4 py-6">
        <ParseProgress :progress="progress" :stage="stage" :filename="run?.error?.message ?? ''" />
      </div>

      <template v-else>
        <!-- The tree keeps a fixed column: it is the index of the run, and a
             pane that resized as branches arrived would move every row under
             the pointer. -->
        <div class="flex w-80 shrink-0 flex-col border-r xl:w-96">
          <ConnectorRunTree
            :items="items"
            :selected-id="selectedId"
            :busy-ids="busyIds"
            :can-manage="canManage"
            :truncated="itemsData?.truncated ?? false"
            @select="selectedId = $event"
            @event="itemEvent"
          />
        </div>

        <div class="min-w-0 flex-1">
          <ConnectorItemReview
            v-if="selected && detail && detail.item.id === selected.id"
            ref="reviewRef"
            v-model:title="title"
            v-model:markdown="markdown"
            :item="detail.item"
            :incoming="detail.incoming"
            :local-head="detail.localHead"
            :can-manage="canManage"
            :ai-busy="aiBusy"
            @ai="runAi"
          />
          <div v-else-if="selected && detailQuery.isPending.value" class="space-y-2 p-6">
            <Skeleton class="h-8 w-2/3" />
            <Skeleton v-for="i in 6" :key="i" class="h-4 w-full" />
          </div>
          <div v-else class="grid h-full place-items-center px-6">
            <AiEmptyState
              :icon="FileStack"
              :title="t('connectors.pickItemTitle')"
              :body="t('connectors.pickItemBody')"
            />
          </div>
        </div>
      </template>
    </div>

    <!-- Fixed frame, part two: the run's controls, in one place, always. -->
    <footer class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-4 py-3 lg:px-6">
      <p class="text-muted-foreground min-w-0 truncate text-xs">
        <template v-if="run">
          {{ stage }}
          <template v-if="run.discovered > 0"> · {{ t('connectors.discoveredCount', { count: run.discovered }, run.discovered) }}</template>
          <template v-if="run.error"> · <span class="text-destructive">{{ run.error.message }}</span></template>
        </template>
      </p>

      <div class="flex flex-wrap items-center gap-2">
        <span v-if="dirty" class="text-muted-foreground text-xs">{{ t('connectors.unsavedEdits') }}</span>
        <Button v-if="dirty" variant="outline" size="sm" :disabled="saving" @click="saveEdits">
          <Loader2 v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
          {{ t('common.save') }}
        </Button>

        <Button
          v-for="type in events"
          :key="type"
          :variant="type === 'APPROVE_ALL' ? 'default' : type === 'CANCEL' ? 'ghost' : 'outline'"
          size="sm"
          :disabled="runBusy !== null"
          @click="runEvent(type)"
        >
          <Loader2 v-if="runBusy === type" class="size-4 animate-spin" aria-hidden="true" />
          {{ t(RUN_EVENT_LABEL[type]) }}
        </Button>
      </div>
    </footer>
  </div>
</template>
