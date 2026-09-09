<script setup lang="ts">
/**
 * A page, the way an issue tracker shows an issue: one main column you read
 * top to bottom — what this is, what it says, what people said about it — and a
 * rail beside it holding everything *about* the page rather than *in* it.
 *
 * The split is deliberate. Revisions, merge requests, the graph and the
 * activity log used to be tabs alongside the content, which made reading the
 * page one option among five; here the content is never hidden, and the rail is
 * where you go to ask a question about it.
 *
 * The content itself is the editor in read mode (feature 15), so what you read
 * is what you would edit, and any passage in it can be commented on.
 */
import { useI18n } from 'vue-i18n'
import { formatDateTime } from '@/lib/format'
import { labelFor } from '@/lib/labels'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity as ActivityIcon,
  Braces,
  GitMerge,
  History,
  Info,
  Pencil,
  Share2,
  Workflow as WorkflowIcon,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type {
  DocumentContentResponse,
  DocumentDetailResponse,
  ListActivityResponse,
  ListDocumentRelationsResponse,
  ListDocumentThreadsResponse,
  ListMergeRequestsResponse,
  ListRevisionsResponse,
  ReviewThreadAnchor,
  DocumentWorkflowRunsResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, relativeTime, statusVariant } from '@/lib/api'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useEventsStore } from '@/stores/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import TocRail from '@/components/knowledge/TocRail.vue'
import RailSection from '@/components/knowledge/RailSection.vue'
import DocumentCanvas from '@/components/knowledge/DocumentCanvas.vue'
import RevisionsView from '@/components/knowledge/RevisionsView.vue'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'
import GraphView from '@/components/knowledge/GraphView.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import WorkflowRail from '@/components/workflows/WorkflowRail.vue'
import AskAssistant from '@/components/knowledge/AskAssistant.vue'

const { t } = useI18n()

const route = useRoute()
const auth = useAuthStore()
const store = useDocumentsStore()
const events = useEventsStore()

const RAIL_WIDGETS = [
  { id: 'overview', label: t('rail.overview'), icon: Info, expandable: false },
  { id: 'frontmatter', label: t('rail.frontmatter'), icon: Braces, expandable: false },
  { id: 'revisions', label: t('rail.history'), icon: History, expandable: true },
  { id: 'merge-requests', label: t('rail.changes'), icon: GitMerge, expandable: true },
  { id: 'graph', label: t('rail.graph'), icon: Share2, expandable: true },
  { id: 'workflows', label: t('rail.workflows'), icon: WorkflowIcon, expandable: false },
  { id: 'activity', label: t('rail.activity'), icon: ActivityIcon, expandable: false },
] as const
type RailWidget = (typeof RAIL_WIDGETS)[number]['id']

const documentId = computed(() => route.params.id as string)
/**
 * The rail is a stack of collapsible widgets, so more than one can be open and
 * "which is open" is not a single value the URL can hold. `?tab=` therefore
 * survives as an *opening* instruction — every existing deep link still lands
 * with the right widget open — rather than as two-way state. Values that used
 * to name a main tab (`overview`, `content`) now describe something always on
 * screen and open nothing in particular.
 */
function initialOpen(): RailWidget[] {
  const q = route.query.tab as RailWidget
  // Overview is what a reader wants without asking; everything else is opened
  // on purpose, or by a deep link that named it.
  return RAIL_WIDGETS.some((w) => w.id === q) ? ['overview', q] : ['overview']
}
const open = ref<RailWidget[]>(initialOpen())
const visibleWidgets = computed(() =>
  RAIL_WIDGETS.filter((w) => w.id !== 'frontmatter' || !!content.value?.frontmatter),
)
const isOpen = (id: RailWidget) => open.value.includes(id)
function setOpen(id: RailWidget, next: boolean) {
  open.value = next ? [...open.value, id] : open.value.filter((x) => x !== id)
}

/** The widget currently blown up into the dialog, if any. */
const expanded = ref<RailWidget | null>(null)
const expandedWidget = computed(() => RAIL_WIDGETS.find((w) => w.id === expanded.value) ?? null)

const detail = ref<DocumentDetailResponse | null>(null)
const content = ref<DocumentContentResponse | null>(null)
const contentError = ref<string | null>(null)
const relations = ref<ListDocumentRelationsResponse['relations'] | null>(null)
const error = ref<string | null>(null)
const headings = ref<{ id: string; text: string; level: number }[]>([])
const outdatedThreads = ref<string[]>([])
/**
 * A well-connected page can carry fifty inferred relations, and showing them
 * all turns the strip above the content into a wall the reader has to scroll
 * past to reach the page. The first dozen answer "what is this connected to";
 * the rest are available on request.
 */
const RELATION_PREVIEW = 12
const showAllRelations = ref(false)
const visibleRelations = computed(() =>
  showAllRelations.value ? (relations.value ?? []) : (relations.value ?? []).slice(0, RELATION_PREVIEW),
)
let timer: ReturnType<typeof setInterval> | undefined

/* ------------------------------------------------------------ page data */

async function load() {
  try {
    detail.value = await apiFetch<DocumentDetailResponse>(`/v1/documents/${documentId.value}`)
    const status = detail.value.revision.status
    if (status === 'indexed' || status === 'failed' || status === 'draft') {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  } catch (e) {
    error.value = (e as Error).message
    if (timer) clearInterval(timer)
  }
}

async function loadContent() {
  contentError.value = null
  content.value = null
  try {
    const rev = route.query.revision ? `?revision=${route.query.revision as string}` : ''
    content.value = await apiFetch<DocumentContentResponse>(
      `/v1/documents/${documentId.value}/content${rev}`,
    )
  } catch (e) {
    contentError.value = (e as Error).message
  }
}

async function loadRelations() {
  try {
    const res = await apiFetch<ListDocumentRelationsResponse>(
      `/v1/documents/${documentId.value}/relations`,
    )
    relations.value = res.relations
  } catch {
    relations.value = []
  }
}

/* -------------------------------------------------------------- comments */

const threadsQuery = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/threads', { path: { id: documentId.value } })),
)
const threads = computed(
  () => (threadsQuery.data.value as ListDocumentThreadsResponse | undefined)?.threads ?? [],
)
// A plain comment has nothing to resolve, so it is not an open request — the
// same rule the API's threadStats applies.
const unresolvedCount = computed(() => threads.value.filter((t) => t.resolvable && !t.resolved).length)

const threadsKey = computed(() => ['/v1/documents/{id}/threads', { id: documentId.value }, null])
// Every comment also lands in the activity log, and the rail reads it — so both
// keys refresh together or the feed shows half the event.
const threadInvalidates = () => [threadsKey.value, ['/v1/activity']]

const createThread = useApiMutation('post', '/v1/documents/{id}/threads', {
  invalidates: threadInvalidates,
})
const replyThread = useApiMutation('post', '/v1/documents/{id}/threads/{threadId}/comments', {
  invalidates: threadInvalidates,
})
const resolveThread = useApiMutation('patch', '/v1/documents/{id}/threads/{threadId}', {
  invalidates: threadInvalidates,
})
const editComment = useApiMutation('patch', '/v1/documents/{id}/threads/{threadId}/comments/{commentId}', {
  invalidates: threadInvalidates,
})
const deleteComment = useApiMutation('delete', '/v1/documents/{id}/threads/{threadId}/comments/{commentId}', {
  invalidates: threadInvalidates,
})
const threadsBusy = computed(
  () =>
    createThread.isPending.value ||
    replyThread.isPending.value ||
    resolveThread.isPending.value ||
    editComment.isPending.value ||
    deleteComment.isPending.value,
)

/** `resolvable`: a plain comment, or a thread that stays open until resolved. */
function onCreateThread(body: string, anchor?: ReviewThreadAnchor, resolvable = false) {
  createThread.mutate(
    { path: { id: documentId.value }, body: { body, resolvable, ...(anchor ? { anchor } : {}) } },
    { onError: (e) => toast.error(e.message) },
  )
}
function onReply(threadId: string, body: string, replyToId: string | null = null) {
  replyThread.mutate(
    {
      path: { id: documentId.value, threadId },
      body: { body, ...(replyToId ? { replyToId } : {}) },
    },
    { onError: (e) => toast.error(e.message) },
  )
}
function onResolve(threadId: string, resolved: boolean) {
  resolveThread.mutate(
    { path: { id: documentId.value, threadId }, body: { resolved } },
    { onError: (e) => toast.error(e.message) },
  )
}
function onEditComment(threadId: string, commentId: string, body: string) {
  editComment.mutate(
    { path: { id: documentId.value, threadId, commentId }, body: { body } },
    { onError: (e) => toast.error(e.message) },
  )
}
function onDeleteComment(threadId: string, commentId: string) {
  deleteComment.mutate(
    { path: { id: documentId.value, threadId, commentId } },
    {
      onSuccess: () => toast.success('Comment deleted'),
      onError: (e) => toast.error(e.message),
    },
  )
}

/**
 * The first open comment that still has a passage to jump to. An outdated
 * anchor has nothing on screen to scroll to, so it is not offered.
 */
const canvasEl = ref<InstanceType<typeof DocumentCanvas> | null>(null)
const jumpTarget = computed(() =>
  threads.value.find(
    (t) =>
      t.resolvable &&
      !t.resolved &&
      t.anchor?.type === 'text' &&
      !outdatedThreads.value.includes(t.threadId),
  ) ?? null,
)
function jumpToComment() {
  if (jumpTarget.value) canvasEl.value?.flashThread(jumpTarget.value.threadId)
}

/** Comment attachments belong to the page being commented on. */
const resolveDocumentId = async () => documentId.value

/* ------------------------------------------------------- rail previews */
/*
 * A collapsed widget has to answer "is there anything in here for me?" — so
 * each one carries the single number or timestamp that decides it. These are
 * small reads, and two of the three are the very query the panel runs when
 * opened, which vue-query dedupes against.
 */

const revisionsPreview = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/revisions', { path: { id: documentId.value } })),
)
const mergeRequestsPreview = useQuery(
  computed(() =>
    apiQueryOptions('/v1/documents/{id}/merge-requests', { path: { id: documentId.value } }),
  ),
)
const workflowsPreview = useQuery(
  computed(() =>
    apiQueryOptions('/v1/documents/{id}/workflow-runs', { path: { id: documentId.value } }),
  ),
)
const activityPreview = useQuery(
  computed(() =>
    apiQueryOptions('/v1/activity', {
      query: { workspaceId: getWorkspaceId(), documentId: documentId.value, limit: '1' },
    }),
  ),
)

const previewFor = computed<Record<RailWidget, string | null>>(() => {
  const revisions = (revisionsPreview.data.value as ListRevisionsResponse | undefined)?.revisions
  const mrs = (mergeRequestsPreview.data.value as ListMergeRequestsResponse | undefined)?.mergeRequests
  const latest = (activityPreview.data.value as ListActivityResponse | undefined)?.entries?.[0]
  const openMrs = mrs?.filter((m) => m.status === 'open').length ?? 0
  const workflowRuns = (workflowsPreview.data.value as DocumentWorkflowRunsResponse | undefined)?.runs
  const workflowsAwaiting =
    workflowRuns?.reduce((sum, r) => sum + r.nodeStats.awaitingReview, 0) ?? 0

  const frontmatterKeys = content.value?.frontmatter
    ? Object.keys(content.value.frontmatter as Record<string, unknown>).length
    : 0

  return {
    overview: detail.value ? `#${detail.value.revision.revisionNumber}` : null,
    frontmatter: frontmatterKeys ? t('count.fields', { n: frontmatterKeys }, frontmatterKeys) : null,
    revisions: revisions ? t('count.revisions', { n: revisions.length }, revisions.length) : null,
    'merge-requests': mrs
      ? openMrs
        ? `${openMrs} open`
        : mrs.length
          ? `${mrs.length} closed`
          : 'none'
      : null,
    graph: relations.value
      ? relations.value.length
        ? t('count.relations', { n: relations.value.length }, relations.value.length)
        : 'no relations'
      : null,
    workflows: workflowRuns
      ? workflowsAwaiting
        ? `${workflowsAwaiting} to review`
        : workflowRuns.length
          ? t('count.runs', { n: workflowRuns.length }, workflowRuns.length)
          : 'none'
      : null,
    activity: latest ? relativeTime(latest.createdAt) : null,
  }
})

/* ------------------------------------------------------------- lifecycle */

const viewingRevision = computed(() => (route.query.revision as string | undefined) ?? null)
const canComment = computed(() => auth.canComment && !viewingRevision.value)

onMounted(() => {
  void load()
  void loadRelations()
  void loadContent()
  if (!store.treeLoaded) void store.fetchTree()
  timer = setInterval(() => void load(), 2000)
})
onUnmounted(() => {
  if (timer) clearInterval(timer)
})

watch(() => route.query.revision, () => void loadContent())

// Route reuse: navigating to a different document keeps this component alive.
watch(documentId, () => {
  detail.value = null
  content.value = null
  relations.value = null
  error.value = null
  headings.value = []
  outdatedThreads.value = []
  if (timer) clearInterval(timer)
  timer = setInterval(() => void load(), 2000)
  void load()
  void loadRelations()
  void loadContent()
})

// Feature 04: live refresh when this document is re-indexed elsewhere.
watch(
  () => events.lastEvent,
  (e) => {
    if (e && e.documentId === documentId.value && e.type.startsWith('revision.')) {
      void load()
      void loadRelations()
      void loadContent()
    }
  },
)
</script>

<template>
  <p v-if="error" class="text-destructive">{{ error }}</p>

  <div v-else-if="!detail" class="space-y-4">
    <Skeleton class="h-8 w-1/2" />
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem] 2xl:grid-cols-[minmax(0,1fr)_32rem]">
      <Skeleton class="h-96 w-full" />
      <Skeleton class="hidden h-72 w-full lg:block" />
    </div>
  </div>

  <div v-else class="space-y-5">
    <!-- Page head ------------------------------------------------------- -->
    <header class="space-y-2">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ detail.document.title }}</h1>
        <Badge variant="outline">{{ labelFor(t, 'category', detail.document.category) }}</Badge>
        <Badge :variant="statusVariant(detail.revision.status)">{{ detail.revision.status }}</Badge>
        <Button v-if="auth.canEdit" variant="outline" size="sm" class="ml-auto" as-child>
          <RouterLink :to="`/documents/${detail.document.documentId}/edit`">
            <Pencil class="size-3.5" />
            Edit
          </RouterLink>
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Revision #{{ detail.revision.revisionNumber }}
        <span class="font-mono">({{ detail.revision.revisionId.slice(0, 8) }})</span>
        <template v-if="detail.revision.finalizedAt">
          · {{ t('documents.finalizedAt', { when: formatDateTime(detail.revision.finalizedAt) }) }}
        </template>
      </p>
    </header>

    <div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem] xl:gap-8 2xl:grid-cols-[minmax(0,1fr)_32rem]">
      <!-- Main column: what this is, what it says, what was said about it -->
      <div class="min-w-0 space-y-6">
        <!-- Content -->
        <section class="space-y-2">
          <p v-if="viewingRevision" class="text-xs text-muted-foreground">
            Viewing revision {{ viewingRevision.slice(0, 8) }} — commenting is off while reading history.
            <RouterLink :to="`/documents/${documentId}`" class="underline">{{ t('documents.backToHead') }}</RouterLink>
          </p>
          <p v-if="contentError" class="text-sm text-destructive">{{ contentError }}</p>
          <Skeleton v-else-if="!content" class="h-96 w-full" />
          <template v-else>
            <DocumentCanvas
              ref="canvasEl"
              :markdown="content.markdown"
              :title="detail.document.title"
              :revision-id="content.revisionId"
              :threads="threads"
              :can-comment="canComment"
              :busy="threadsBusy"
              :resolve-document-id="resolveDocumentId"
              @create-thread="onCreateThread"
              @reply="onReply"
              @resolve="onResolve"
              @edit="onEditComment"
              @delete="onDeleteComment"
              @outdated="outdatedThreads = $event"
              @headings="headings = $event"
            />
          </template>
        </section>

      </div>

      <!-- Rail: everything about the page rather than in it ------------- -->
      <aside class="lg:sticky lg:top-6 space-y-3">
        <TocRail v-if="headings.length > 1" :headings="headings" />

        <RailSection
          v-for="w in visibleWidgets"
          :key="w.id"
          :icon="w.icon"
          :title="w.label"
          :preview="previewFor[w.id]"
          :open="isOpen(w.id)"
          :expandable="w.expandable"
          @update:open="setOpen(w.id, $event)"
          @expand="expanded = w.id"
        >
          <!-- What this page *is*: the facts a reader checks before trusting it. -->
          <template v-if="w.id === 'overview'">
            <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
              <dt class="text-muted-foreground">{{ t('documents.revision') }}</dt>
              <dd class="text-right">
                #{{ detail.revision.revisionNumber }}
                <span class="font-mono text-xs">{{ detail.revision.revisionId.slice(0, 8) }}</span>
              </dd>
              <dt class="text-muted-foreground">{{ t('documents.status') }}</dt>
              <dd class="text-right">
                <Badge :variant="statusVariant(detail.revision.status)">{{ detail.revision.status }}</Badge>
              </dd>
              <dt class="text-muted-foreground">{{ t('documents.category') }}</dt>
              <dd class="truncate text-right">{{ labelFor(t, 'category', detail.document.category) }}</dd>
              <dt class="text-muted-foreground">{{ t('documents.type') }}</dt>
              <dd class="truncate text-right">{{ detail.revision.contentType }}</dd>
              <dt class="text-muted-foreground">{{ t('documents.finalized') }}</dt>
              <dd class="text-right">
                {{ detail.revision.finalizedAt ? formatDateTime(detail.revision.finalizedAt) : '—' }}
              </dd>
              <dt class="text-muted-foreground">{{ t('documents.hash') }}</dt>
              <dd class="truncate text-right font-mono text-xs" :title="detail.revision.contentHash ?? ''">
                {{ detail.revision.contentHash?.slice(0, 12) ?? '—' }}
              </dd>
            </dl>

            <div v-if="relations && relations.length" class="mt-3 border-t pt-3">
              <p class="mb-1.5 text-xs text-muted-foreground">
                Relations <span class="text-foreground">{{ relations.length }}</span>
              </p>
              <div class="flex flex-wrap gap-1.5">
                <span
                  v-for="(r, i) in visibleRelations"
                  :key="i"
                  class="inline-flex items-baseline gap-1.5 rounded-full border bg-background px-2 py-0.5 text-xs"
                  :title="`${r.provenance.extractor} · confidence ${r.provenance.confidence}`"
                >
                  <span class="text-muted-foreground">{{ r.type }}</span>
                  <span class="font-medium">{{ r.to.name }}</span>
                </span>
                <button
                  v-if="relations.length > RELATION_PREVIEW"
                  class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  @click="showAllRelations = !showAllRelations"
                >
                  {{ showAllRelations ? 'Show fewer' : `+${relations.length - RELATION_PREVIEW} more` }}
                </button>
              </div>
            </div>
          </template>

          <pre
            v-else-if="w.id === 'frontmatter'"
            class="overflow-x-auto rounded bg-muted/40 p-2 text-xs"
          >{{ JSON.stringify(content?.frontmatter, null, 2) }}</pre>

          <RevisionsView v-else-if="w.id === 'revisions'" :document-id="documentId" />
          <MergeRequestList v-else-if="w.id === 'merge-requests'" :document-id="documentId" />
          <GraphView v-else-if="w.id === 'graph'" :document-id="documentId" />
          <WorkflowRail v-else-if="w.id === 'workflows'" :document-id="documentId" />
          <ActivityFeed v-else :document-id="documentId" />
        </RailSection>

        <p v-if="jumpTarget" class="px-1 text-xs text-muted-foreground">
          <button class="underline underline-offset-2 hover:text-foreground" @click="jumpToComment">
            {{ t('count.openComments', { n: unresolvedCount }, unresolvedCount) }}
          </button>
        </p>
      </aside>
    </div>

    <!-- A widget, given room. A graph or a revision table needs width the rail
         does not have, and sending the reader to another page to get it loses
         their place. -->
    <Dialog :open="expanded !== null" @update:open="(v: boolean) => !v && (expanded = null)">
      <DialogContent class="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{{ expandedWidget?.label }} — {{ detail.document.title }}</DialogTitle>
        </DialogHeader>
        <div class="max-h-[70vh] overflow-auto pr-1">
          <RevisionsView v-if="expanded === 'revisions'" :document-id="documentId" />
          <MergeRequestList v-else-if="expanded === 'merge-requests'" :document-id="documentId" />
          <GraphView v-else-if="expanded === 'graph'" :document-id="documentId" />
          <ActivityFeed v-else-if="expanded === 'activity'" :document-id="documentId" />
        </div>
      </DialogContent>
    </Dialog>

    <!-- Ask-AI chat about this page -->
    <AskAssistant :document-id="documentId" :title="detail.document.title" />
  </div>
</template>
