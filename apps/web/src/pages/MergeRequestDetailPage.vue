<script setup lang="ts">
// Merge-request detail: plan.md §8's three views (Changes / Structure /
// Knowledge impact) plus an Overview tab holding the description, reviewers,
// approvals and the discussion. Tab state lives in ?tab= like DocumentDetailPage.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type {
  ListMergeRequestThreadsResponse,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestThreadAnchor,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { relativeTime, statusVariant } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import DiffView from '@/components/knowledge/DiffView.vue'
import MergeRequestActions from '@/components/merge-requests/MergeRequestActions.vue'
import ReviewerPicker from '@/components/merge-requests/ReviewerPicker.vue'
import ThreadCard from '@/components/merge-requests/ThreadCard.vue'
import CommentComposer from '@/components/merge-requests/CommentComposer.vue'
import { matchAnchoredThreads } from '@/components/merge-requests/thread-anchors'

const TABS = ['overview', 'changes', 'structure', 'impact'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  changes: 'Changes',
  structure: 'Structure',
  impact: 'Knowledge impact',
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const id = computed(() => String(route.params.id))

const tab = computed<Tab>(() =>
  TABS.includes(route.query.tab as Tab) ? (route.query.tab as Tab) : 'overview',
)
function setTab(next: Tab) {
  void router.replace({ query: { ...route.query, tab: next === 'overview' ? undefined : next } })
}

// --- queries -----------------------------------------------------------------
const detailQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests/{id}', { path: { id: id.value } })),
)
const mr = computed(
  () => (detailQuery.data.value as { mergeRequest: MergeRequestInfo } | undefined)?.mergeRequest,
)

const diffQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/merge-requests/{id}/diff', { path: { id: id.value } }),
    enabled: tab.value === 'changes' || tab.value === 'structure',
  })),
)
const diff = computed(
  () => (diffQuery.data.value as MergeRequestDiffResponse | undefined)?.compare ?? null,
)

const impactQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/merge-requests/{id}/diff', {
      path: { id: id.value },
      query: { semantic: 'true' },
    }),
    enabled: tab.value === 'impact',
  })),
)
const semantic = computed(
  () => (impactQuery.data.value as MergeRequestDiffResponse | undefined)?.compare.semantic ?? null,
)

const threadsQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests/{id}/threads', { path: { id: id.value } })),
)
const threads = computed(
  () => (threadsQuery.data.value as ListMergeRequestThreadsResponse | undefined)?.threads ?? [],
)

/** Threads that don't render inline in the diff — shown on the Overview tab. */
const discussion = computed(() => matchAnchoredThreads(diff.value, threads.value))

const isOpen = computed(() => mr.value?.status === 'open')

// --- discussion mutations ----------------------------------------------------
const threadsKey = computed(() => ['/v1/merge-requests/{id}/threads', { id: id.value }, null])
const threadInvalidates = () => [threadsKey.value]

const createThread = useApiMutation('post', '/v1/merge-requests/{id}/threads', {
  invalidates: threadInvalidates,
})
const replyThread = useApiMutation('post', '/v1/merge-requests/{id}/threads/{threadId}/comments', {
  invalidates: threadInvalidates,
})
const resolveThread = useApiMutation('patch', '/v1/merge-requests/{id}/threads/{threadId}', {
  invalidates: threadInvalidates,
})
const threadsBusy = computed(
  () => createThread.isPending.value || replyThread.isPending.value || resolveThread.isPending.value,
)

/** Pending anchor from a diff-gutter click; rendered as a composer at the top of the Changes tab. */
const pendingAnchor = ref<MergeRequestThreadAnchor | null>(null)

function onCreateThread(body: string, anchor?: MergeRequestThreadAnchor) {
  createThread.mutate(
    { path: { id: id.value }, body: { body, ...(anchor ? { anchor } : {}) } },
    {
      onSuccess: () => (pendingAnchor.value = null),
      onError: (e) => toast.error(e.message),
    },
  )
}
function onReply(threadId: string, body: string) {
  replyThread.mutate(
    { path: { id: id.value, threadId }, body: { body } },
    { onError: (e) => toast.error(e.message) },
  )
}
function onResolve(threadId: string, resolved: boolean) {
  resolveThread.mutate(
    { path: { id: id.value, threadId }, body: { resolved } },
    { onError: (e) => toast.error(e.message) },
  )
}
function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}', { id: id.value }, null] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}/diff'] })
}
</script>

<template>
  <div class="mx-auto max-w-5xl space-y-4 p-6">
    <Skeleton v-if="!mr && detailQuery.isPending.value" class="h-32 w-full" />
    <p v-else-if="!mr" class="py-10 text-center text-sm text-muted-foreground">Merge request not found.</p>
    <template v-else>
      <!-- header -->
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <Badge :variant="statusVariant(mr.status)">{{ mr.status }}</Badge>
          <Badge v-if="mr.isDraft" variant="outline">Draft</Badge>
          <h1 class="text-xl font-semibold">{{ mr.title }}</h1>
        </div>
        <p class="text-sm text-muted-foreground">
          <RouterLink :to="`/documents/${mr.documentId}`" class="text-primary hover:underline">document</RouterLink>
          · <span class="font-mono text-xs">{{ mr.sourceBranch }} → {{ mr.targetBranch }}</span>
          · opened {{ relativeTime(mr.createdAt) }} by <span class="font-mono text-xs">{{ mr.authorId.slice(0, 8) }}</span>
          <template v-if="mr.approvedBy.length"> · {{ mr.approvedBy.length }} approval(s)</template>
        </p>
        <MergeRequestActions :merge-request="mr" @changed="refresh" />
      </div>

      <!-- tabs -->
      <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
        <button
          v-for="t in TABS"
          :key="t"
          role="tab"
          :aria-selected="tab === t"
          class="border-b-2 px-3 py-2 text-sm"
          :class="tab === t ? 'border-primary font-medium text-primary' : 'border-transparent text-muted-foreground hover:text-foreground'"
          @click="setTab(t)"
        >{{ TAB_LABELS[t] }}</button>
      </div>

      <!-- overview -->
      <div v-if="tab === 'overview'" class="grid gap-4 md:grid-cols-[1fr_240px]">
        <div class="space-y-4">
          <Card v-if="mr.description">
            <CardContent class="pt-4"><MarkdownView :markdown="mr.description" /></CardContent>
          </Card>
          <div class="space-y-3">
            <h2 class="text-sm font-medium">Discussion</h2>
            <p v-if="discussion.discussion.length === 0" class="text-sm text-muted-foreground">No threads yet.</p>
            <ThreadCard
              v-for="thread in discussion.discussion"
              :key="thread.threadId"
              :thread="thread"
              :outdated="discussion.outdatedIds.has(thread.threadId)"
              :readonly="!isOpen"
              :busy="threadsBusy"
              @reply="(b) => onReply(thread.threadId, b)"
              @resolve="(r) => onResolve(thread.threadId, r)"
            />
            <CommentComposer
              v-if="isOpen"
              submit-label="Start thread"
              :busy="threadsBusy"
              @submit="(b) => onCreateThread(b)"
            />
          </div>
        </div>
        <div class="space-y-4">
          <ReviewerPicker :merge-request="mr" :readonly="!isOpen" @changed="refresh" />
          <div class="text-xs text-muted-foreground">
            <p v-if="mr.mergeBaseRevisionId">merge base <span class="font-mono">{{ mr.mergeBaseRevisionId.slice(0, 8) }}</span></p>
            <p v-if="mr.mergedRevisionId">merged as <span class="font-mono">{{ mr.mergedRevisionId.slice(0, 8) }}</span> ({{ mr.strategy }})</p>
          </div>
        </div>
      </div>

      <!-- changes -->
      <div v-else-if="tab === 'changes'" class="space-y-3">
        <Skeleton v-if="diffQuery.isPending.value" class="h-40 w-full" />
        <template v-else-if="diff">
          <Card v-if="pendingAnchor">
            <CardHeader class="pb-2"><CardTitle class="text-sm">New thread on line {{ pendingAnchor.type === 'line' ? pendingAnchor.line : '' }}</CardTitle></CardHeader>
            <CardContent>
              <CommentComposer
                submit-label="Start thread"
                :busy="threadsBusy"
                @submit="(b) => onCreateThread(b, pendingAnchor ?? undefined)"
              />
            </CardContent>
          </Card>
          <DiffView
            :compare="diff"
            :threads="threads"
            :can-comment="isOpen"
            @create-thread="(a) => (pendingAnchor = a)"
          >
            <template #thread="{ thread }">
              <ThreadCard
                :thread="thread"
                :readonly="!isOpen"
                :busy="threadsBusy"
                @reply="(b) => onReply(thread.threadId, b)"
                @resolve="(r) => onResolve(thread.threadId, r)"
              />
            </template>
          </DiffView>
        </template>
      </div>

      <!-- structure -->
      <div v-else-if="tab === 'structure'">
        <Skeleton v-if="diffQuery.isPending.value" class="h-24 w-full" />
        <Card v-else>
          <CardHeader><CardTitle class="text-sm">Structural changes</CardTitle></CardHeader>
          <CardContent>
            <p v-if="!diff?.structural || diff.structural.changes.length === 0" class="text-sm text-muted-foreground">
              No structural (frontmatter / JSON / YAML) changes.
            </p>
            <div v-else class="space-y-1">
              <p class="mb-1 text-xs text-muted-foreground">source: {{ diff.structural.source }}</p>
              <p v-for="(c, i) in diff.structural.changes" :key="i" class="font-mono text-xs">
                <span :class="c.kind === 'added' ? 'text-green-600' : c.kind === 'removed' ? 'text-red-600' : 'text-amber-600'">{{ c.kind }}</span>
                {{ c.path || '(root)' }}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- knowledge impact -->
      <div v-else-if="tab === 'impact'" class="space-y-4">
        <Skeleton v-if="impactQuery.isPending.value" class="h-24 w-full" />
        <p v-else-if="!semantic" class="text-sm text-muted-foreground">
          No graph projection to compare — both sides must be indexed.
        </p>
        <template v-else>
          <div class="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader><CardTitle class="text-sm">Entities</CardTitle></CardHeader>
              <CardContent class="space-y-1 text-sm">
                <p v-if="semantic.entities.added.length === 0 && semantic.entities.removed.length === 0" class="text-muted-foreground">No entity changes.</p>
                <p v-for="e in semantic.entities.added" :key="`a-${e}`" class="font-mono text-xs text-green-600">+ {{ e }}</p>
                <p v-for="e in semantic.entities.removed" :key="`r-${e}`" class="font-mono text-xs text-red-600">− {{ e }}</p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle class="text-sm">Relations</CardTitle></CardHeader>
              <CardContent class="space-y-1 text-sm">
                <p v-if="semantic.relations.added.length === 0 && semantic.relations.removed.length === 0" class="text-muted-foreground">No relation changes.</p>
                <p v-for="(r, i) in semantic.relations.added" :key="`a-${i}`" class="font-mono text-xs text-green-600">
                  + {{ r.type }} → {{ r.targetKey }} <span class="text-muted-foreground">({{ r.extractor }}, {{ r.confidence }})</span>
                </p>
                <p v-for="(r, i) in semantic.relations.removed" :key="`r-${i}`" class="font-mono text-xs text-red-600">
                  − {{ r.type }} → {{ r.targetKey }} <span class="text-muted-foreground">({{ r.extractor }}, {{ r.confidence }})</span>
                </p>
              </CardContent>
            </Card>
          </div>
          <Card v-if="semantic.embeddingShift">
            <CardContent class="pt-4 text-sm">
              Embedding shift
              <span class="font-mono">{{ semantic.embeddingShift.score.toFixed(3) }}</span>
              <Badge :variant="semantic.embeddingShift.meaningful ? 'default' : 'secondary'" class="ml-2">
                {{ semantic.embeddingShift.meaningful ? 'meaningful' : 'minor' }}
              </Badge>
            </CardContent>
          </Card>
        </template>
      </div>
    </template>
  </div>
</template>
