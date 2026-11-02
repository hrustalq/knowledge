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
import { useI18n } from 'vue-i18n'
import { labelFor } from '@/shared/i18n/labels'
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { warnMentionedWithoutAccess } from '@/entities/access'
import { documentDetailQuery } from '@/entities/document'
import { useMembers } from '@/entities/person'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Pencil } from 'lucide-vue-next'
import type {
  DocumentContentResponse,
  DocumentDetailResponse,
  ListMergeRequestThreadsResponse,
  MergeRequestApiChangesResponse,
  MergeRequestPage,
  MergeRequestDiffResponse,
  MergeRequestInfo,
  MergeRequestThreadAnchor,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { relativeTime } from '@/shared/api/api'
import { useAuthStore } from '@/stores/auth'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Skeleton } from '@/shared/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Input } from '@/shared/ui/input'
import { Textarea } from '@/shared/ui/textarea'
import { MarkdownView } from '@/entities/document'
import { DiffView } from '@/entities/document'
import { DocumentCanvas } from '@/entities/merge-request'
import MergeWidget from '@/modules/merge-requests/components/MergeWidget.vue'
import MrSidebar from '@/modules/merge-requests/components/MrSidebar.vue'
import MrActivityFeed from '@/modules/merge-requests/components/MrActivityFeed.vue'
import MrProvenance from '@/modules/merge-requests/components/MrProvenance.vue'
import { ApiChangesPanel } from '@/entities/api-operation'
import { ThreadCard } from '@/entities/merge-request'
import { CommentComposer } from '@/entities/merge-request'
import { matchAnchoredThreads } from '@/entities/document'
import { mrIcon } from '@/entities/merge-request'
import { UserChip } from '@/entities/person'
import { PageTabs, panelId, tabId, usePageTabs, type PageTab } from '@/shared/layout'

const { t } = useI18n()

const TABS = ['overview', 'review', 'changes', 'structure', 'api', 'impact'] as const
type Tab = (typeof TABS)[number]
const TAB_LABELS: Record<Tab, string> = {
  overview: 'mr.tabOverview',
  review: 'mr.tabReview',
  changes: 'mr.tabChanges',
  structure: 'mr.tabStructure',
  api: 'mr.tabApi',
  impact: 'mr.tabImpact',
}

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const auth = useAuthStore()
const id = computed(() => String(route.params.id))

// --- queries -----------------------------------------------------------------
const detailQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests/{id}', { path: { id: id.value } })),
)
const mr = computed(
  () => (detailQuery.data.value as { mergeRequest: MergeRequestInfo } | undefined)?.mergeRequest,
)

/**
 * What the merge request does to its API (#78). Asked for on every merge
 * request: a page answers `applicable: false` from one row read, and the
 * answer decides whether the API tab exists and whether the merge widget has
 * a breaking-change row. The diff behind it is cached per revision pair.
 */
const apiQuery = useQuery(
  computed(() => apiQueryOptions('/v1/merge-requests/{id}/api-changes', { path: { id: id.value } })),
)
const apiChanges = computed(
  () => (apiQuery.data.value as MergeRequestApiChangesResponse | undefined) ?? null,
)
const visibleTabs = computed<readonly Tab[]>(() =>
  apiChanges.value?.applicable ? TABS : TABS.filter((t) => t !== 'api'),
)

// Validated against the keys only, never `pageTabs`: its counts come from the
// queries below that `tab` enables, and useQuery reads `tab` as it is created —
// before `pageTabs` exists (#576).
const tab = usePageTabs<Tab>(() => visibleTabs.value.map((key) => ({ key })), 'overview')
function setTab(next: Tab) {
  tab.value = next
}

const diffQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/merge-requests/{id}/diff', { path: { id: id.value } }),
    enabled: tab.value === 'changes' || tab.value === 'structure',
  })),
)
const diffResponse = computed(() => (diffQuery.data.value as MergeRequestDiffResponse | undefined) ?? null)
const diff = computed(
  () => diffResponse.value?.compare ?? null,
)

/**
 * Every page the merge request changes and the caller may open (#636), the
 * page it was opened from first. A merge request with nothing left to merge
 * (merged, say) lists none, and then shows its own page's comparison as before.
 */
const diffPages = computed<MergeRequestPage[]>(() => {
  const res = diffResponse.value
  if (!res) return []
  if (res.pages.length > 0) return res.pages
  return [{ documentId: res.mergeRequest.documentId, title: '', compare: res.compare }]
})
const multiPage = computed(() => diffPages.value.length > 1)
const diffTotals = computed(() =>
  diffPages.value.reduce(
    (sum, p) => ({ additions: sum.additions + p.compare.summary.additions, deletions: sum.deletions + p.compare.summary.deletions }),
    { additions: 0, deletions: 0 },
  ),
)
/** A line comment's page: an excerpt only re-anchors within the page it was written on. */
function threadsOn(documentId: string) {
  return threads.value.filter((t) => t.documentId === documentId)
}

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
/** The page's project, so review mode links only its vocabulary (#702). Shares the page view's cache entry. */
const reviewDocQuery = useQuery(
  computed(() => ({
    ...documentDetailQuery(mr.value?.documentId ?? ''),
    enabled: tab.value === 'review' && !!mr.value?.documentId,
  })),
)
const reviewProjectId = computed(
  () => (reviewDocQuery.data.value as DocumentDetailResponse | undefined)?.document.projectId ?? null,
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
 * Line comments whose anchor no longer resolves, page by page. The timeline
 * lists every thread regardless — a comment that only exists on the Changes
 * tab is a comment nobody reading the overview knows about — but outdated
 * anchors are only knowable once the diff has loaded.
 */
const outdatedInDiff = computed(
  () => new Set(diffPages.value.flatMap((p) => [...matchAnchoredThreads(p.compare, threadsOn(p.documentId)).outdatedIds])),
)

/** Both review surfaces report staleness; the timeline shows the union. */
const allOutdatedIds = computed(
  () => new Set([...outdatedInDiff.value, ...reviewOutdated.value]),
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
  changes: diffPages.value.reduce((n, p) => n + p.compare.hunks.length, 0) || undefined,
  api: apiChanges.value?.diff?.changes.length || undefined,
}))

const pageTabs = computed<PageTab<Tab>[]>(() =>
  visibleTabs.value.map((key) => ({ key, label: t(TAB_LABELS[key]), count: tabCounts.value[key] })),
)

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
        toast.success(t('mr.updated'))
      },
      onError: (e) => toast.error(errorMessage(e, t)),
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
const deleteComment = useApiMutation(
  'delete',
  '/v1/merge-requests/{id}/threads/{threadId}/comments/{commentId}',
  { invalidates: threadInvalidates },
)
const threadsBusy = computed(
  () =>
    createThread.isPending.value ||
    replyThread.isPending.value ||
    resolveThread.isPending.value ||
    editComment.isPending.value ||
    deleteComment.isPending.value,
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
function onCreateThread(
  body: string,
  anchor?: MergeRequestThreadAnchor,
  resolvable = false,
  source: 'human' | 'ai' = 'human',
) {
  createThread.mutate(
    { path: { id: id.value }, body: { body, resolvable, source, ...(anchor ? { anchor } : {}) } },
    {
      onSuccess: (data) => {
        pendingAnchor.value = null
        warnMentions(data)
      },
      onError: (e) => toast.error(errorMessage(e, t)),
    },
  )
}
/** AI findings posted from the rail land on Overview, where the thread will be. */
function onAiComment(body: string) {
  onCreateThread(body, undefined, false, 'ai')
  if (tab.value !== 'overview') setTab('overview')
  toast.success(t('mr.findingsPosted'))
}
function onReply(threadId: string, body: string, replyToId: string | null = null) {
  replyThread.mutate(
    { path: { id: id.value, threadId }, body: { body, ...(replyToId ? { replyToId } : {}) } },
    { onSuccess: warnMentions, onError: (e) => toast.error(errorMessage(e, t)) },
  )
}

/** Named people who cannot open the page were not told (#76); its Access dialog is on the page. */
const { nameOf } = useMembers()
function warnMentions(data: unknown) {
  warnMentionedWithoutAccess(data, {
    t,
    nameOf,
    openAccess: () => {
      if (mr.value?.documentId) void router.push(`/documents/${mr.value.documentId}?access=1`)
    },
  })
}
function onResolve(threadId: string, resolved: boolean) {
  resolveThread.mutate(
    { path: { id: id.value, threadId }, body: { resolved } },
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onEditComment(threadId: string, commentId: string, body: string) {
  editComment.mutate(
    { path: { id: id.value, threadId, commentId }, body: { body } },
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onDeleteComment(threadId: string, commentId: string) {
  deleteComment.mutate(
    { path: { id: id.value, threadId, commentId } },
    {
      onSuccess: () => toast.success(t('mr.commentDeleted')),
      onError: (e) => toast.error(errorMessage(e, t)),
    },
  )
}
function refresh() {
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}', { id: id.value }, null] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}/diff'] })
  void queryClient.invalidateQueries({ queryKey: ['/v1/merge-requests/{id}/api-changes'] })
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
          {{ labelFor(t, 'mr.state', mr.status) }}
        </Badge>
        <Badge v-if="mr.isDraft" variant="outline">{{ t('mr.draft') }}</Badge>
        <Button
          v-if="canEdit && isOpen"
          variant="outline"
          size="sm"
          class="ml-auto"
          @click="startEdit"
        >
          <Pencil class="size-3.5" /> {{ t('common.edit') }}
        </Button>
      </div>

      <!-- inline title/description editor -->
      <div v-else class="space-y-2 rounded-lg border bg-card p-3">
        <Input v-model="editTitle" :placeholder="t('mr.titlePlaceholder')" :aria-label="t('mr.titlePlaceholder')" />
        <Textarea
          v-model="editDescription"
          rows="4"
          :placeholder="t('mr.descriptionPlaceholder')"
          :aria-label="t('mr.descriptionPlaceholder')"
          class="font-mono text-sm"
        />
        <div class="flex gap-2">
          <Button size="sm" :disabled="updateMr.isPending.value || !editTitle.trim()" @click="saveEdit">{{ t('common.save') }}</Button>
          <Button size="sm" variant="ghost" :disabled="updateMr.isPending.value" @click="editing = false">{{ t('common.cancel') }}</Button>
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        <UserChip :user-id="mr.authorId" size="sm" class="font-medium text-foreground" />
        {{ t('mr.requestedToMerge') }}
        <RouterLink
          :to="`/documents/${mr.documentId}?tab=revisions`"
          class="font-mono text-primary hover:underline"
        >{{ mr.sourceBranch }}</RouterLink>
        {{ t('mr.into') }}
        <RouterLink
          :to="`/documents/${mr.documentId}?tab=revisions`"
          class="font-mono text-primary hover:underline"
        >{{ mr.targetBranch }}</RouterLink>
        · {{ t('mr.openedAgo', { when: relativeTime(mr.createdAt) }) }}
        ·
        <RouterLink :to="`/documents/${mr.documentId}`" class="text-primary hover:underline">
          {{ t('mr.viewDocument') }}
        </RouterLink>
      </p>
      <MrProvenance :merge-request="mr" />
    </header>

    <MergeWidget
      :merge-request="mr"
      :unresolved-threads="unresolvedCount"
      :api-changes="apiChanges"
      @changed="refresh"
      @review-api="setTab('api')"
    />

    <!-- Content column + rail. `items-start` keeps the aside from stretching,
         which is what lets it stick. -->
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px] lg:items-start">
      <div class="min-w-0 space-y-4">
        <PageTabs v-model="tab" :tabs="pageTabs" :label="t('mr.tabsLabel')" />

        <div :id="panelId(tab)" role="tabpanel" :aria-labelledby="tabId(tab)" class="space-y-4">
        <!-- overview: description, then one timeline -->
        <template v-if="tab === 'overview'">
          <!-- The merge widget's box, not a Card: a Card's own 1.5rem inset
               plus its content's put 2.5rem above a one-line description. The
               first and last block margins go too, so the text sits in the
               box the way the widget's rows do. -->
          <div
            v-if="mr.description"
            class="rounded-lg border bg-card px-4 py-3 [&_.markdown-body>:first-child]:mt-0 [&_.markdown-body>:last-child]:mb-0"
          >
            <MarkdownView :markdown="mr.description" />
          </div>

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
            @delete="onDeleteComment"
            @create-thread="(b, r) => onCreateThread(b, undefined, r)"
          />
        </template>

        <!-- review: the page as a reader sees it, annotated in place -->
        <div v-else-if="tab === 'review'" class="space-y-3">
          <Skeleton v-if="contentQuery.isPending.value" class="h-64 w-full" />
          <p v-else-if="!sourceHead" class="text-sm text-muted-foreground">
            {{ t('mr.noFinalizedRevision') }}
          </p>
          <p v-else-if="!reviewContent" class="text-sm text-muted-foreground">
            {{ t('mr.contentNotLoaded') }}
          </p>
          <DocumentCanvas
            v-else
            :markdown="reviewContent.markdown"
            :document-id="reviewContent.documentId"
            :project-id="reviewProjectId"
            :frontmatter="reviewContent.frontmatter"
            :revision-id="reviewContent.revisionId"
            :threads="threads"
            :can-comment="canComment"
            :busy="threadsBusy"
            :resolve-document-id="resolveDocumentId"
            thread-kind="mr-thread"
            @create-thread="onCreateThread"
            @reply="onReply"
            @resolve="onResolve"
            @edit="onEditComment"
            @delete="onDeleteComment"
            @outdated="outdatedInReview = $event"
          />
        </div>

        <!-- changes -->
        <div v-else-if="tab === 'changes'" class="space-y-3">
          <Skeleton v-if="diffQuery.isPending.value" class="h-40 w-full" />
          <template v-else-if="diffPages.length">
            <p class="text-xs text-muted-foreground">
              {{ t('mr.comparingAgainst') }} <span class="font-mono">{{ mr.sourceBranch }}</span>
              <template v-if="multiPage"> — {{ t('mr.pagesChanged', { n: diffPages.length }, diffPages.length) }}</template>
              — <span class="text-panel-tip-ink">+{{ diffTotals.additions }}</span>
              <span class="ml-1 text-panel-caution-ink">−{{ diffTotals.deletions }}</span>
            </p>
            <p v-if="diffResponse?.hiddenPages" class="text-xs text-muted-foreground">
              {{ t('mr.pagesHidden', { n: diffResponse.hiddenPages }, diffResponse.hiddenPages) }}
            </p>
            <!-- A merge request spans every page its branch changed (#636): an index, then one section each. -->
            <nav v-if="multiPage" :aria-label="t('mr.pagesIndex')" class="rounded-lg border bg-card">
              <ul class="divide-y text-sm">
                <li v-for="page in diffPages" :key="page.documentId">
                  <a
                    :href="`#mr-page-${page.documentId}`"
                    class="flex items-baseline gap-3 px-3 py-2 hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                  >
                    <span class="min-w-0 flex-1 truncate">{{ page.title || t('mr.untitledPage') }}</span>
                    <span class="shrink-0 font-mono text-xs tabular-nums">
                      <span class="text-panel-tip-ink">+{{ page.compare.summary.additions }}</span>
                      <span class="ml-1 text-panel-caution-ink">−{{ page.compare.summary.deletions }}</span>
                    </span>
                  </a>
                </li>
              </ul>
            </nav>
            <section
              v-for="page in diffPages"
              :id="`mr-page-${page.documentId}`"
              :key="page.documentId"
              class="scroll-mt-20 space-y-3"
              :aria-label="multiPage ? page.title || t('mr.untitledPage') : undefined"
            >
              <h3 v-if="multiPage" class="flex items-baseline gap-3 border-b pb-1.5 pt-2 text-sm font-semibold">
                <RouterLink :to="`/documents/${page.documentId}`" class="min-w-0 flex-1 truncate hover:underline">
                  {{ page.title || t('mr.untitledPage') }}
                </RouterLink>
                <span class="shrink-0 font-mono text-xs font-normal tabular-nums">
                  <span class="text-panel-tip-ink">+{{ page.compare.summary.additions }}</span>
                  <span class="ml-1 text-panel-caution-ink">−{{ page.compare.summary.deletions }}</span>
                </span>
              </h3>
              <div
                v-if="pendingAnchor && (!('revisionId' in pendingAnchor) || pendingAnchor.revisionId === page.compare.to.revisionId)"
                class="rounded-lg border bg-card p-3"
              >
                <p class="mb-2 text-xs font-medium">
                  {{ t('mr.newComment') }}<template v-if="pendingAnchor.type === 'line'"> {{ t('mr.onLine', { n: pendingAnchor.line }) }}</template>
                  <button class="ml-2 text-muted-foreground hover:text-foreground" @click="pendingAnchor = null">{{ t('common.cancel') }}</button>
                </p>
                <CommentComposer
                  auto-expand
                  offer-thread
                  :placeholder="t('review.writeComment')"
                  :submit-label="t('review.comment')"
                  :busy="threadsBusy"
                  :resolve-document-id="resolveDocumentId"
                  @submit="(b, r) => onCreateThread(b, pendingAnchor ?? undefined, r)"
                />
              </div>
              <DiffView
                :compare="page.compare"
                :threads="threadsOn(page.documentId)"
                :can-comment="canComment"
                @create-thread="(a) => (pendingAnchor = a)"
              >
                <template #thread="{ thread }">
                  <ThreadCard
                    :thread="thread"
                    :readonly="!canComment"
                    :busy="threadsBusy"
                    :resolve-document-id="resolveDocumentId"
                    teach-kind="mr-thread"
                    @reply="(b, p) => onReply(thread.threadId, b, p)"
                    @resolve="(r) => onResolve(thread.threadId, r)"
                    @edit="(c, b) => onEditComment(thread.threadId, c, b)"
                    @delete="(c) => onDeleteComment(thread.threadId, c)"
                  />
                </template>
              </DiffView>
            </section>
          </template>
        </div>

        <!-- structure -->
        <div v-else-if="tab === 'structure'">
          <Skeleton v-if="diffQuery.isPending.value" class="h-24 w-full" />
          <Card v-else>
            <CardHeader><CardTitle class="text-sm">{{ t('mr.structuralChanges') }}</CardTitle></CardHeader>
            <CardContent>
              <p v-if="!diff?.structural || diff.structural.changes.length === 0" class="text-sm text-muted-foreground">
                {{ t('mr.noStructuralChanges') }}
              </p>
              <div v-else class="space-y-1">
                <p class="mb-1 text-xs text-muted-foreground">{{ t('mr.source', { name: diff.structural.source }) }}</p>
                <p v-for="(c, i) in diff.structural.changes" :key="i" class="font-mono text-xs">
                  <span :class="c.kind === 'added' ? 'text-panel-tip-ink' : c.kind === 'removed' ? 'text-panel-caution-ink' : 'text-panel-warning-ink'">{{ t(`mr.change${c.kind[0].toUpperCase()}${c.kind.slice(1)}`) }}</span>
                  {{ c.path || t('mr.root') }}
                </p>
              </div>
            </CardContent>
          </Card>
        </div>

        <!-- API changes (#78): only on a spec -->
        <div v-else-if="tab === 'api'" class="space-y-3">
          <Skeleton v-if="apiQuery.isPending.value" class="h-24 w-full" />
          <template v-else-if="apiChanges">
            <p class="text-sm text-muted-foreground">{{ t(`mr.api.policy.${apiChanges.policy}`) }}</p>
            <ApiChangesPanel
              v-if="apiChanges.diff"
              :diff="apiChanges.diff"
              :document-id="apiChanges.documentId"
              :affected-pages="apiChanges.affectedPages"
            />
            <p v-else class="text-sm text-muted-foreground">{{ t('mr.api.notParsed') }}</p>
          </template>
        </div>

        <!-- knowledge impact -->
        <div v-else-if="tab === 'impact'" class="space-y-4">
          <Skeleton v-if="impactQuery.isPending.value" class="h-24 w-full" />
          <p v-else-if="!semantic" class="text-sm text-muted-foreground">
            {{ t('mr.noGraphProjection') }}
          </p>
          <template v-else>
            <div class="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader><CardTitle class="text-sm">{{ t('mr.entities') }}</CardTitle></CardHeader>
                <CardContent class="space-y-1 text-sm">
                  <p v-if="semantic.entities.added.length === 0 && semantic.entities.removed.length === 0" class="text-muted-foreground">{{ t('mr.noEntityChanges') }}</p>
                  <p v-for="e in semantic.entities.added" :key="`a-${e}`" class="font-mono text-xs text-panel-tip-ink">+ {{ e }}</p>
                  <p v-for="e in semantic.entities.removed" :key="`r-${e}`" class="font-mono text-xs text-panel-caution-ink">− {{ e }}</p>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle class="text-sm">{{ t('mr.relations') }}</CardTitle></CardHeader>
                <CardContent class="space-y-1 text-sm">
                  <p v-if="semantic.relations.added.length === 0 && semantic.relations.removed.length === 0" class="text-muted-foreground">{{ t('mr.noRelationChanges') }}</p>
                  <p v-for="(r, i) in semantic.relations.added" :key="`a-${i}`" class="font-mono text-xs text-panel-tip-ink">
                    + {{ r.type }} → {{ r.targetKey }} <span class="text-muted-foreground">({{ r.extractor }}, {{ r.confidence }})</span>
                  </p>
                  <p v-for="(r, i) in semantic.relations.removed" :key="`r-${i}`" class="font-mono text-xs text-panel-caution-ink">
                    − {{ r.type }} → {{ r.targetKey }} <span class="text-muted-foreground">({{ r.extractor }}, {{ r.confidence }})</span>
                  </p>
                </CardContent>
              </Card>
            </div>
            <Card v-if="semantic.embeddingShift">
              <CardContent class="pt-4 text-sm">
                {{ t('mr.embeddingShift') }}
                <span class="font-mono">{{ semantic.embeddingShift.score.toFixed(3) }}</span>
                <Badge :variant="semantic.embeddingShift.meaningful ? 'default' : 'secondary'" class="ml-2">
                  {{ semantic.embeddingShift.meaningful ? t('mr.meaningful') : t('mr.minor') }}
                </Badge>
              </CardContent>
            </Card>
          </template>
        </div>
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
