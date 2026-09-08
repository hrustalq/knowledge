<script setup lang="ts">
// Merge-request detail — GitLab-inspired: header with inline title/description
// editing, merge widget, tabs with counts (Overview / Changes / Structure /
// Knowledge impact per plan.md §8), and a sticky rail.
//
// The rail sits beside every tab, not just Overview. Who is assigned, who is
// reviewing and what the AI check said are facts about the merge request, and
// they are most wanted exactly where they used to disappear: halfway down a
// diff.
//
// Overview is one timeline. State changes come from the activity log, threads
// from the review API, and they are sorted together — see MrActivityFeed.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Pencil } from 'lucide-vue-next'
import type {
  DocumentContentResponse,
  ListMergeRequestThreadsResponse,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestThreadAnchor,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import DiffView from '@/components/knowledge/DiffView.vue'
import DocumentCanvas from '@/components/knowledge/DocumentCanvas.vue'
import MergeWidget from '@/components/merge-requests/MergeWidget.vue'
import MrSidebar from '@/components/merge-requests/MrSidebar.vue'
import MrActivityFeed from '@/components/merge-requests/MrActivityFeed.vue'
import ThreadCard from '@/components/merge-requests/ThreadCard.vue'
import CommentComposer from '@/components/merge-requests/CommentComposer.vue'
import { matchAnchoredThreads } from '@/components/merge-requests/thread-anchors'
import { actorLabel, mrIcon } from '@/components/merge-requests/mr-ui'

const TABS = ['overview', 'review', 'changes', 'structure', 'impact'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  overview: 'Overview',
  review: 'Review',
  changes: 'Changes',
  structure: 'Structure',
  impact: 'Knowledge impact',
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const auth = useAuthStore()
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

/**
 * Review mode reads the page itself, at the revision being proposed — not the
 * diff. Only fetched on that tab: it is a second document body, and every
 * other tab already has everything it needs.
 */
const sourceHead = computed(() => mr.value?.sourceHeadRevisionId ?? null)
const contentQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/documents/{id}/content', {
      path: { id: mr.value?.documentId ?? '' },
      query: { revision: sourceHead.value ?? undefined },
    }),
    enabled: tab.value === 'review' && !!mr.value?.documentId && !!sourceHead.value,
  })),
)
const reviewContent = computed(
  () => (contentQuery.data.value as DocumentContentResponse | undefined) ?? null,
)

const threadsQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests/{id}/threads', { path: { id: id.value } })),
)
const threads = computed(
  () => (threadsQuery.data.value as ListMergeRequestThreadsResponse | undefined)?.threads ?? [],
)
// A plain comment has nothing to resolve, so it is not an open request — the
// same rule the API's threadStats applies.
const unresolvedCount = computed(() => threads.value.filter((t) => t.resolvable && !t.resolved).length)

/**
 * Which threads render inline in the diff. The timeline lists all of them
 * regardless — a comment that only exists on the Changes tab is a comment
 * nobody reading the overview knows about — but outdated anchors are still
 * only knowable once the diff has loaded.
 */
const matched = computed(() => matchAnchoredThreads(diff.value, threads.value))

/** Both review surfaces report staleness; the timeline shows the union. */
const allOutdatedIds = computed(
  () => new Set([...matched.value.outdatedIds, ...reviewOutdated.value]),
)

const isOpen = computed(() => mr.value?.status === 'open')
const canEdit = computed(() => auth.canEdit)
const canComment = computed(() => isOpen.value && canEdit.value)

/**
 * Anchors that no longer resolve on the rendered page. Reported by the canvas
 * rather than computed here: whether a quote still exists is a fact about the
 * DOM the reader is looking at, not about the thread row.
 */
const outdatedInReview = ref<string[]>([])
const reviewOutdated = computed(() => new Set(outdatedInReview.value))

const tabCounts = computed<Partial<Record<Tab, number>>>(() => ({
  overview: threads.value.length || undefined,
  review: threads.value.filter((t) => t.anchor?.type === 'text').length || undefined,
  changes: diff.value?.hunks.length || undefined,
}))

// --- title/description inline editing (GitLab-style) -------------------------
const editing = ref(false)
const editTitle = ref('')
const editDescription = ref('')

const updateMr = useApiMutation('patch', '/v1/merge-requests/{id}', {
  invalidates: () => [
    ['/v1/merge-requests/{id}', { id: id.value }, null],
    ['/v1/merge-requests'],
    ['/v1/activity'],
  ],
})

function startEdit() {
  if (!mr.value) return
  editTitle.value = mr.value.title
  editDescription.value = mr.value.description ?? ''
  editing.value = true
}
function saveEdit() {
  if (!editTitle.value.trim()) return
  updateMr.mutate(
    {
      path: { id: id.value },
      body: { title: editTitle.value.trim(), description: editDescription.value },
    },
    {
      onSuccess: () => {
        editing.value = false
        toast.success('Merge request updated')
      },
      onError: (e) => toast.error(e.message),
    },
  )
}

// --- discussion mutations ----------------------------------------------------
const threadsKey = computed(() => ['/v1/merge-requests/{id}/threads', { id: id.value }, null])
// Every thread write also lands in the activity log, and the timeline reads
// both — so both keys refresh together or the feed shows half the event.
const threadInvalidates = () => [threadsKey.value, ['/v1/activity']]

const createThread = useApiMutation('post', '/v1/merge-requests/{id}/threads', {
  invalidates: threadInvalidates,
})
const replyThread = useApiMutation('post', '/v1/merge-requests/{id}/threads/{threadId}/comments', {
  invalidates: threadInvalidates,
})
const resolveThread = useApiMutation('patch', '/v1/merge-requests/{id}/threads/{threadId}', {
  invalidates: threadInvalidates,
})
const editComment = useApiMutation(
  'patch',
  '/v1/merge-requests/{id}/threads/{threadId}/comments/{commentId}',
  { invalidates: threadInvalidates },
)
const threadsBusy = computed(
  () =>
    createThread.isPending.value ||
    replyThread.isPending.value ||
    resolveThread.isPending.value ||
    editComment.isPending.value,
)

/** Comment attachments are stored against the document this MR targets. */
const resolveDocumentId = async () => mr.value?.documentId ?? null

/** Pending anchor from a diff-gutter click; rendered as a composer above the diff. */
const pendingAnchor = ref<MergeRequestThreadAnchor | null>(null)

/**
 * `resolvable` is GitLab's Comment vs. Start thread: a remark, or a request
 * that stays open until someone resolves it. Composers that offer the choice
 * pass it; the ones that don't (the AI rail) post a plain comment.
 */
function onCreateThread(body: string, anchor?: MergeRequestThreadAnchor, resolvable = false) {
  createThread.mutate(
    { path: { id: id.value }, body: { body, resolvable, ...(anchor ? { anchor } : {}) } },
    {
      onSuccess: () => (pendingAnchor.value = null),
      onError: (e) => toast.error(e.message),
    },
  )
}
/** AI findings posted from the rail land on Overview, where the thread will be. */
function onAiComment(body: string) {
  onCreateThread(body)
  if (tab.value !== 'overview') setTab('overview')
  toast.success('Findings posted to the discussion')
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
function onEditComment(threadId: string, commentId: string, body: string) {
  editComment.mutate(
    { path: { id: id.value, threadId, commentId }, body: { body } },
    { onError: (e) => toast.error(e.message) },
  )
}
function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}', { id: id.value }, null] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}/diff'] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/activity'] })
}
</script>

<template>
  <p v-if="detailQuery.error.value" class="text-destructive">{{ detailQuery.error.value.message }}</p>

  <div v-else-if="!mr" class="space-y-2">
    <Skeleton class="h-8 w-1/2" />
    <Skeleton class="h-40 w-full" />
  </div>

  <div v-else class="space-y-4">
    <!-- header -->
    <header class="space-y-2">
      <div v-if="!editing" class="flex flex-wrap items-center gap-3">
        <component :is="mrIcon(mr).icon" class="size-5 shrink-0" :class="mrIcon(mr).class" />
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ mr.title }}</h1>
        <Badge :variant="mr.status === 'open' ? 'default' : mr.status === 'merged' ? 'secondary' : 'outline'">
          {{ mr.status }}
        </Badge>
        <Badge v-if="mr.isDraft" variant="outline">Draft</Badge>
        <Button
          v-if="canEdit && isOpen"
          variant="outline"
          size="sm"
          class="ml-auto"
          @click="startEdit"
        >
          <Pencil class="size-3.5" /> Edit
        </Button>
      </div>

      <!-- inline title/description editor -->
      <div v-else class="space-y-2 rounded-lg border bg-card p-3">
        <Input v-model="editTitle" placeholder="Title" />
        <Textarea v-model="editDescription" rows="4" placeholder="Description (markdown)" class="font-mono text-sm" />
        <div class="flex gap-2">
          <Button size="sm" :disabled="updateMr.isPending.value || !editTitle.trim()" @click="saveEdit">Save</Button>
          <Button size="sm" variant="ghost" :disabled="updateMr.isPending.value" @click="editing = false">Cancel</Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        <span class="font-medium text-foreground">{{ actorLabel(mr.authorId) }}</span>
        requested to merge
        <RouterLink
          :to="`/documents/${mr.documentId}?tab=revisions`"
          class="font-mono text-primary hover:underline"
        >{{ mr.sourceBranch }}</RouterLink>
        into
        <RouterLink
          :to="`/documents/${mr.documentId}?tab=revisions`"
          class="font-mono text-primary hover:underline"
        >{{ mr.targetBranch }}</RouterLink>
        · opened {{ relativeTime(mr.createdAt) }}
        ·
        <RouterLink :to="`/documents/${mr.documentId}`" class="text-primary hover:underline">
          view document
        </RouterLink>
      </p>
    </header>

    <MergeWidget :merge-request="mr" :unresolved-threads="unresolvedCount" @changed="refresh" />

    <!-- Content column + rail. `items-start` keeps the aside from stretching,
         which is what lets it stick. -->
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <div class="min-w-0 space-y-4">
        <!-- tabs -->
        <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
          <button
            v-for="t in TABS"
            :key="t"
            role="tab"
            :aria-selected="tab === t"
            class="flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors"
            :class="tab === t
              ? 'border-primary font-medium text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'"
            @click="setTab(t)"
          >
            {{ TAB_LABELS[t] }}
            <span
              v-if="tabCounts[t]"
              class="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground"
            >{{ tabCounts[t] }}</span>
          </button>
        </div>

        <!-- overview: description, then one timeline -->
        <template v-if="tab === 'overview'">
          <Card v-if="mr.description">
            <CardContent class="pt-4"><MarkdownView :markdown="mr.description" /></CardContent>
          </Card>

          <MrActivityFeed
            :merge-request-id="mr.mergeRequestId"
            :document-id="mr.documentId"
            :threads="threads"
            :outdated-ids="allOutdatedIds"
            :readonly="!canComment"
            :busy="threadsBusy"
            @reply="onReply"
            @resolve="onResolve"
            @edit="onEditComment"
            @create-thread="(b, r) => onCreateThread(b, undefined, r)"
          />
        </template>

        <!-- review: the page as a reader sees it, annotated in place -->
        <div v-else-if="tab === 'review'" class="space-y-3">
          <Skeleton v-if="contentQuery.isPending.value" class="h-64 w-full" />
          <p v-else-if="!sourceHead" class="text-sm text-muted-foreground">
            The source branch has no finalized revision yet — there is nothing to read.
          </p>
          <p v-else-if="!reviewContent" class="text-sm text-muted-foreground">
            This revision's content could not be loaded.
          </p>
          <DocumentCanvas
            v-else
            :markdown="reviewContent.markdown"
            :revision-id="reviewContent.revisionId"
            :threads="threads"
            :can-comment="canComment"
            :busy="threadsBusy"
            :resolve-document-id="resolveDocumentId"
            @create-thread="onCreateThread"
            @reply="onReply"
            @resolve="onResolve"
            @edit="onEditComment"
            @outdated="outdatedInReview = $event"
          />
        </div>

        <!-- changes -->
        <div v-else-if="tab === 'changes'" class="space-y-3">
          <Skeleton v-if="diffQuery.isPending.value" class="h-40 w-full" />
          <template v-else-if="diff">
            <p class="text-xs text-muted-foreground">
              Comparing merge base against <span class="font-mono">{{ mr.sourceBranch }}</span>
              — <span class="text-emerald-600">+{{ diff.summary.additions }}</span>
              <span class="text-red-600">−{{ diff.summary.deletions }}</span>
            </p>
            <div v-if="pendingAnchor" class="rounded-lg border bg-card p-3">
              <p class="mb-2 text-xs font-medium">
                New comment<template v-if="pendingAnchor.type === 'line'"> on line {{ pendingAnchor.line }}</template>
                <button class="ml-2 text-muted-foreground hover:text-foreground" @click="pendingAnchor = null">cancel</button>
              </p>
              <CommentComposer
                auto-expand
                offer-thread
                placeholder="Write a comment…"
                submit-label="Comment"
                :busy="threadsBusy"
                :resolve-document-id="resolveDocumentId"
                @submit="(b, r) => onCreateThread(b, pendingAnchor ?? undefined, r)"
              />
            </div>
            <DiffView
              :compare="diff"
              :threads="threads"
              :can-comment="canComment"
              @create-thread="(a) => (pendingAnchor = a)"
            >
              <template #thread="{ thread }">
                <ThreadCard
                  :thread="thread"
                  :readonly="!canComment"
                  :busy="threadsBusy"
                  :resolve-document-id="resolveDocumentId"
                  @reply="(b) => onReply(thread.threadId, b)"
                  @resolve="(r) => onResolve(thread.threadId, r)"
                  @edit="(c, b) => onEditComment(thread.threadId, c, b)"
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
      </div>

      <!-- rail: present on every tab -->
      <MrSidebar
        :merge-request="mr"
        :readonly="!canComment"
        :can-comment="canComment"
        :busy="threadsBusy"
        @changed="refresh"
        @comment="onAiComment"
      />
    </div>
  </div>
</template>
