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
import { errorMessage } from '@/api/errors'
import { labelFor } from '@/lib/labels'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity as ActivityIcon,
  BookA,
  Braces,
  GitMerge,
  History,
  Plug,
  Info,
  Pencil,
  Share2,
  Workflow as WorkflowIcon,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type {
  DocumentConnectorResponse,
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
import { PageLayout, PageRail, PageState } from '@/components/layout/page'
import TocRail from '@/components/knowledge/TocRail.vue'
import DocumentCanvas from '@/components/knowledge/DocumentCanvas.vue'
import RevisionsView from '@/components/knowledge/RevisionsView.vue'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'
import GraphView from '@/components/knowledge/GraphView.vue'
import GraphLightbox from '@/components/graph/GraphLightbox.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import WorkflowRail from '@/components/workflows/WorkflowRail.vue'
import ConnectorRail from '@/components/connectors/ConnectorRail.vue'
import AskAssistant from '@/components/knowledge/AskAssistant.vue'
import WatchButton from '@/components/notifications/WatchButton.vue'

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
  { id: 'connectors', label: t('rail.connectors'), icon: Plug, expandable: false },
  { id: 'activity', label: t('rail.activity'), icon: ActivityIcon, expandable: false },
] as const
type RailWidget = (typeof RAIL_WIDGETS)[number]['id']

const documentId = computed(() => route.params.id as string)

/**
 * Which widgets are open, and the `?tab=` opening instruction that seeds them,
 * now belong to PageRail — along with remembering the set across pages, which
 * is new: the rail used to reset to Overview on every document, so a reader who
 * always checks History opened it again on every one.
 *
 * Frontmatter is filtered out entirely rather than shown empty: a widget whose
 * answer is "this page has none" is a row that costs a glance to dismiss.
 */
const visibleWidgets = computed(() =>
  RAIL_WIDGETS.filter((w) => w.id !== 'frontmatter' || !!content.value?.frontmatter),
)

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
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onReply(threadId: string, body: string, replyToId: string | null = null) {
  replyThread.mutate(
    {
      path: { id: documentId.value, threadId },
      body: { body, ...(replyToId ? { replyToId } : {}) },
    },
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onResolve(threadId: string, resolved: boolean) {
  resolveThread.mutate(
    { path: { id: documentId.value, threadId }, body: { resolved } },
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onEditComment(threadId: string, commentId: string, body: string) {
  editComment.mutate(
    { path: { id: documentId.value, threadId, commentId }, body: { body } },
    { onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onDeleteComment(threadId: string, commentId: string) {
  deleteComment.mutate(
    { path: { id: documentId.value, threadId, commentId } },
    {
      onSuccess: () => toast.success(t('documents.commentDeleted')),
      onError: (e) => toast.error(errorMessage(e, t)),
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

const connectorsPreview = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/connectors', { path: { id: documentId.value } })),
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

  const connectorLinks = (connectorsPreview.data.value as DocumentConnectorResponse | undefined)?.links

  return {
    overview: detail.value ? `#${detail.value.revision.revisionNumber}` : null,
    // The collapsed row carries the one fact that decides whether to open it:
    // which system this page answers to, or nothing at all.
    connectors: connectorLinks?.length
      ? (connectorLinks[0].connectorName ?? null)
      : null,
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
  <PageState v-if="error" state="error" :description="error" />

  <!-- Shaped like the page it stands in for — a title, a column, a rail —
       rather than a stack of generic bars, so the layout does not visibly
       re-flow the moment the real thing lands on top of it. -->
  <div v-else-if="!detail" class="space-y-4">
    <Skeleton class="h-8 w-1/2" />
    <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] xl:grid-cols-[minmax(0,1fr)_28rem]">
      <Skeleton class="h-96 w-full" />
      <Skeleton class="hidden h-72 w-full lg:block" />
    </div>
  </div>

  <template v-else>
    <PageLayout variant="detail" :title="detail.document.title">
      <template #status>
        <Badge variant="outline">{{ labelFor(t, 'category', detail.document.category) }}</Badge>
        <Badge :variant="statusVariant(detail.revision.status)">{{ detail.revision.status }}</Badge>
      </template>

      <template #actions>
        <!-- Only on pages that actually have vocabulary in them: a switch for
             something the page does not do is noise. -->
        <Button
          v-if="canvasEl?.hasGlossary"
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          :aria-pressed="canvasEl?.glossaryOn"
          :title="canvasEl?.glossaryOn ? t('glossary.linksOn') : t('glossary.linksOff')"
          @click="canvasEl?.toggleGlossaryLinks()"
        >
          <BookA class="size-3.5" :class="canvasEl?.glossaryOn ? 'text-primary' : 'opacity-60'" />
          {{ t('glossary.toggleLinks') }}
        </Button>
        <!-- Watch sits before Edit: following a page is open to every reader,
             while editing is not, so a viewer still sees a balanced row. -->
        <WatchButton subject-type="document" :subject-id="detail.document.documentId" />
        <Button v-if="auth.canEdit" variant="outline" size="sm" as-child>
          <RouterLink :to="`/documents/${detail.document.documentId}/edit`">
            <Pencil class="size-3.5" />
            {{ t('common.edit') }}
          </RouterLink>
        </Button>
      </template>

      <template #meta>
        <p class="text-xs text-muted-foreground">
          Revision #{{ detail.revision.revisionNumber }}
          <span class="font-mono">({{ detail.revision.revisionId.slice(0, 8) }})</span>
          <template v-if="detail.revision.finalizedAt">
            · {{ t('documents.finalizedAt', { when: formatDateTime(detail.revision.finalizedAt) }) }}
          </template>
        </p>
      </template>

      <!-- Rail: everything about the page rather than in it ------------- -->
      <template #rail>
        <PageRail
          :widgets="visibleWidgets"
          surface="document"
          :previews="previewFor"
          @expand="expanded = $event"
        >
          <!-- Above the stack and outside it: the contents belong to the page
               being read, not to the facts about it. -->
          <template #before>
            <TocRail v-if="headings.length > 1" :headings="headings" />
          </template>

          <!-- What this page *is*: the facts a reader checks before trusting it. -->
          <template #widget-overview>
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
                {{ t('documents.relationsCount') }} <span class="text-foreground">{{ relations.length }}</span>
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

          <template #widget-frontmatter>
            <pre class="overflow-x-auto rounded bg-muted/40 p-2 text-xs">{{ JSON.stringify(content?.frontmatter, null, 2) }}</pre>
          </template>

          <template #widget-revisions><RevisionsView :document-id="documentId" /></template>
          <template #widget-merge-requests><MergeRequestList :document-id="documentId" /></template>
          <template #widget-graph><GraphView :document-id="documentId" /></template>
          <template #widget-workflows><WorkflowRail :document-id="documentId" /></template>
          <template #widget-connectors><ConnectorRail :document-id="documentId" /></template>
          <template #widget-activity><ActivityFeed :document-id="documentId" /></template>

          <!-- Under the stack rather than in it: this is the way back to a
               passage somebody is waiting on, not a fact about the page. -->
          <template #after>
            <p v-if="jumpTarget" class="px-1 text-xs text-muted-foreground">
              <button class="underline underline-offset-2 hover:text-foreground" @click="jumpToComment">
                {{ t('count.openComments', { n: unresolvedCount }, unresolvedCount) }}
              </button>
            </p>
          </template>
        </PageRail>
      </template>

      <!-- Main column: what this is, what it says, what was said about it -->
      <section class="space-y-2">
        <p v-if="viewingRevision" class="text-xs text-muted-foreground">
          Viewing revision {{ viewingRevision.slice(0, 8) }} — commenting is off while reading history.
          <RouterLink :to="`/documents/${documentId}`" class="underline">{{ t('documents.backToHead') }}</RouterLink>
        </p>
        <PageState v-if="contentError" state="error" :description="contentError" />
        <PageState v-else-if="!content" state="loading" :rows="1" row-class="h-96" />
        <DocumentCanvas
          v-else
          ref="canvasEl"
          :markdown="content.markdown"
          :document-id="documentId"
          :frontmatter="content.frontmatter"
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
      </section>
    </PageLayout>

    <!-- A widget, given room. A revision table or a change list needs width the
         rail does not have, and sending the reader to another page to get it
         loses their place. -->
    <Dialog
      :open="expanded !== null && expanded !== 'graph'"
      @update:open="(v: boolean) => !v && (expanded = null)"
    >
      <DialogContent class="max-w-5xl">
        <DialogHeader>
          <DialogTitle>{{ expandedWidget?.label }} — {{ detail.document.title }}</DialogTitle>
        </DialogHeader>
        <div class="max-h-[70vh] overflow-auto pr-1">
          <RevisionsView v-if="expanded === 'revisions'" :document-id="documentId" />
          <MergeRequestList v-else-if="expanded === 'merge-requests'" :document-id="documentId" />
          <ActivityFeed v-else-if="expanded === 'activity'" :document-id="documentId" />
        </div>
      </DialogContent>
    </Dialog>

    <!-- The graph gets its own frame rather than the scrolling dialog above.
         A force layout inside a 64rem box with the page still showing around it
         is the rail's problem at a larger size; this is the gallery gesture —
         everything else goes away and the graph fills the screen. -->
    <GraphLightbox
      :open="expanded === 'graph'"
      :title="`${t('rail.graph')} — ${detail.document.title}`"
      @update:open="(v: boolean) => !v && (expanded = null)"
    >
      <GraphView :document-id="documentId" variant="full" />
    </GraphLightbox>

    <!-- Ask-AI chat about this page -->
    <AskAssistant :document-id="documentId" :title="detail.document.title" />
  </template>
</template>
