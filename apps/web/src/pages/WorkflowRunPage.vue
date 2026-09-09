<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { ArrowLeft, PauseCircle, PlayCircle, XCircle } from 'lucide-vue-next'
import type {
  WorkflowNodeEventType,
  WorkflowRunEventType,
  WorkflowRunResponse,
} from '@knowledge/contracts'
import { allowedRunEvents } from '@knowledge/workflow'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import WorkflowNodePanel from '@/components/workflows/WorkflowNodePanel.vue'
import WorkflowRunTree from '@/components/workflows/WorkflowRunTree.vue'
import { isBusyStatus, RUN_STATUS_CLASS, RUN_STATUS_ICON, RUN_STATUS_LABEL } from '@/components/workflows/workflow-ui'

/**
 * One run: the chain on the left, the selected step's draft on the right
 * (docs/features/17).
 *
 * Nothing here polls. The run advances in the worker and arrives over the live
 * channel, so a reviewer can leave the page open and watch nodes fill in — and
 * a reviewer who comes back a week later sees exactly where it parked.
 */
const route = useRoute()
const auth = useAuthStore()
const runId = computed(() => String(route.params.id))

const query = useQuery(
  computed(() => apiQueryOptions('/v1/workflows/runs/{id}', { path: { id: runId.value } })),
)
const data = computed(() => query.data.value as WorkflowRunResponse | undefined)
const nodes = computed(() => data.value?.nodes ?? [])

const selectedId = ref<string | null>(null)
const selected = computed(() => nodes.value.find((n) => n.id === selectedId.value) ?? null)

// Land on whatever needs a person; failing that, the first node. Opening a run
// on an arbitrary node would make the reviewer hunt for their own job.
watch(nodes, (list) => {
  if (selectedId.value && list.some((n) => n.id === selectedId.value)) return
  selectedId.value = (list.find((n) => n.status === 'awaiting-review') ?? list[0])?.id ?? null
})

const invalidates = () => [['/v1/workflows/runs'], ['/v1/documents']]
const nodeEvent = useApiMutation('post', '/v1/workflows/runs/{id}/nodes/{nodeId}/events', { invalidates })
const saveDraft = useApiMutation('patch', '/v1/workflows/runs/{id}/nodes/{nodeId}', { invalidates })
const runEvent = useApiMutation('post', '/v1/workflows/runs/{id}/events', { invalidates })

const busy = computed(() => nodeEvent.isPending.value || runEvent.isPending.value)

const runActions = computed<WorkflowRunEventType[]>(() =>
  data.value && auth.canEdit ? allowedRunEvents(data.value.run.status) : [],
)

async function sendNodeEvent(type: WorkflowNodeEventType, draft?: { title: string; markdown: string }) {
  if (!selected.value) return
  try {
    await nodeEvent.mutateAsync({
      path: { id: runId.value, nodeId: selected.value.id },
      body: { type, ...(draft ? { draft } : {}) },
    })
    await query.refetch()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function persistDraft(draft: { title: string; markdown: string }) {
  if (!selected.value) return
  try {
    await saveDraft.mutateAsync({ path: { id: runId.value, nodeId: selected.value.id }, body: { draft } })
    await query.refetch()
    toast.success('Draft saved')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function sendRunEvent(type: WorkflowRunEventType) {
  if (type === 'CANCEL' && !confirm('Cancel this run? Steps still queued will be skipped.')) return
  try {
    await runEvent.mutateAsync({ path: { id: runId.value }, body: { type } })
    await query.refetch()
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const RUN_ACTION = {
  PAUSE: { label: 'Pause', icon: PauseCircle },
  RESUME: { label: 'Resume', icon: PlayCircle },
  CANCEL: { label: 'Cancel', icon: XCircle },
} as const
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col gap-4">
    <div v-if="query.isLoading.value" class="space-y-3">
      <Skeleton class="h-8 w-64" />
      <Skeleton class="h-64 w-full" />
    </div>

    <template v-else-if="data">
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <h1 class="mt-1 truncate text-lg font-semibold">{{ data.run.definitionName }}</h1>
          <p
            v-if="data.run.nodeStats.awaitingReview"
            class="mt-1 text-sm font-medium text-amber-600 dark:text-amber-500"
          >
            {{ data.run.nodeStats.awaitingReview }} card{{ data.run.nodeStats.awaitingReview === 1 ? '' : 's' }}
            waiting for you
          </p>
          <p class="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-1.5 text-xs">
            <component
              :is="RUN_STATUS_ICON[data.run.status]"
              class="size-3.5"
              :class="[RUN_STATUS_CLASS[data.run.status], isBusyStatus(data.run.status) ? 'animate-spin' : '']"
            />
            {{ RUN_STATUS_LABEL[data.run.status] }}
            <span>·</span>
            <RouterLink :to="`/documents/${data.run.rootDocumentId}`" class="hover:underline">
              {{ data.run.rootDocumentTitle ?? 'source page' }}
            </RouterLink>
            <span>· started {{ relativeTime(data.run.startedAt ?? data.run.createdAt) }}</span>
            <span>· {{ data.run.nodeStats.materialized }} of {{ data.run.nodeStats.total }} published</span>
          </p>
        </div>

        <div class="flex shrink-0 flex-wrap gap-2">
          <Button
            v-for="action in runActions"
            :key="action"
            size="sm"
            :variant="action === 'CANCEL' ? 'ghost' : 'outline'"
            :class="action === 'CANCEL' ? 'text-muted-foreground hover:text-destructive' : ''"
            :disabled="busy"
            @click="sendRunEvent(action)"
          >
            <component :is="RUN_ACTION[action].icon" class="mr-1.5 size-4" />
            {{ RUN_ACTION[action].label }}
          </Button>
        </div>
      </header>

      <p v-if="data.run.error" class="text-destructive bg-destructive/5 rounded-md border px-3 py-2 text-sm">
        {{ data.run.error }}
      </p>

      <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
        <aside class="flex min-h-0 flex-col overflow-hidden rounded-lg border">
          <p class="text-muted-foreground border-b px-3 py-2 text-xs font-medium">
            What this run produced
          </p>
          <div class="min-h-0 flex-1 overflow-auto p-2">
          <WorkflowRunTree
            :nodes="nodes"
            :graph="data.graph"
            :selected-id="selectedId"
            @select="(id) => (selectedId = id)"
          />
          </div>
        </aside>

        <section class="flex min-h-0 flex-col overflow-hidden rounded-lg border p-4">
          <WorkflowNodePanel
            v-if="selected"
            :node="selected"
            :graph="data.graph"
            :nodes="nodes"
            :can-edit="auth.canEdit"
            :busy="busy"
            @event="sendNodeEvent"
            @save="persistDraft"
            @select="(id) => (selectedId = id)"
          />
          <p v-else class="text-muted-foreground py-16 text-center text-sm">
            This run has produced nothing yet.
          </p>
        </section>
      </div>
    </template>
  </div>
</template>
