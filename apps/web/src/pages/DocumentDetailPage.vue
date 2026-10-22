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
import { formatDate, formatDateTime } from '@/lib/format'
import { errorMessage, isRestrictedRefusal } from '@/api/errors'
import { labelFor } from '@/lib/labels'
import { hasWorkingCopy } from '@/lib/working-copy'
import { readFrontmatter } from '@/lib/page-source'
import { usePageView } from '@/lib/use-page-view'
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import {
  Activity as ActivityIcon,
  BadgeCheck,
  Braces,
  Download,
  Flag,
  Gauge,
  GitMerge,
  History,
  LayoutTemplate,
  Lock,
  LockOpen,
  MoreHorizontal,
  Plug,
  Info,
  Network,
  Pencil,
  Scale,
  Share2,
  Workflow as WorkflowIcon,
  ListTree,
  Eye,
  MessageSquare,
} from 'lucide-vue-next'
import { toast } from 'vue-sonner'
import type {
  CodeUsagesResponse,
  ComponentDeclarationView,
  DocumentConnectorResponse,
  DocumentContentResponse,
  ResolvedAsOf,
  DocumentDetailResponse,
  ListActivityResponse,
  ListKnowledgeIssuesResponse,
  ListConflictsResponse,
  DocumentQualityResponse,
  PageInsightsResponse,
  ListDocumentRelationsResponse,
  ListDocumentThreadsResponse,
  ListMergeRequestsResponse,
  ListRevisionsResponse,
  ReviewThreadAnchor,
  DocumentWorkflowRunsResponse,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, relativeTime, statusVariant } from '@/lib/api'
import { EXPORT_FORMATS, isOpenIssueStatus, type ExportFormat } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import CollabDraftBadge from '@/components/editor/CollabDraftBadge.vue'
import ComponentDeclarationNotice from '@/components/code/ComponentDeclarationNotice.vue'
import UsedByRail from '@/components/code/UsedByRail.vue'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { useEventsStore } from '@/stores/events'
import { useLayoutStore } from '@/stores/layout'
import { useTemplatesStore } from '@/stores/templates'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import SaveAsTemplateDialog, { type SaveAsTemplatePage } from '@/components/templates/SaveAsTemplateDialog.vue'
import ExportDialog from '@/components/knowledge/ExportDialog.vue'
import { PageLayout, PageRail, PageState } from '@/components/layout/page'
import TocRail from '@/components/knowledge/TocRail.vue'
import DocumentCanvas from '@/components/knowledge/DocumentCanvas.vue'
import ThreadCard from '@/components/merge-requests/ThreadCard.vue'
import ApiOperationIndex from '@/components/api-reference/ApiOperationIndex.vue'
import { useApiReference } from '@/components/api-reference/use-api-reference'
import MergeRequestList from '@/components/merge-requests/MergeRequestList.vue'
import GraphLightbox from '@/components/graph/GraphLightbox.vue'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
import WorkflowRail from '@/components/workflows/WorkflowRail.vue'
import ConnectorRail from '@/components/connectors/ConnectorRail.vue'
import ConflictsRail from '@/components/knowledge/ConflictsRail.vue'
import KnowledgeIssuesRail from '@/components/knowledge/KnowledgeIssuesRail.vue'
import QualityRail from '@/components/quality/QualityRail.vue'
import PageInsightsRail from '@/components/analytics/PageInsightsRail.vue'
import AskAssistant from '@/components/knowledge/AskAssistant.vue'
import WatchButton from '@/components/notifications/WatchButton.vue'
import PageAiActions from '@/components/knowledge/PageAiActions.vue'
import SharePopover from '@/components/knowledge/SharePopover.vue'
import PageAccessDialog from '@/components/access/PageAccessDialog.vue'
import RequestAccessCard from '@/components/access/RequestAccessCard.vue'
import { warnMentionedWithoutAccess } from '@/components/access/mention-access'
import { useMembers } from '@/components/merge-requests/use-members'
import VerificationBar from '@/components/verification/VerificationBar.vue'

// Behind a widget, a dialog or a spec page only: a reader of an ordinary page
// never needs the force layout, the revision table or the API reference, so
// none of them rides in this page's chunk. SSR still renders them (it awaits
// async components), and hydration waits for the chunk before it adopts the DOM.
const ApiReferenceView = defineAsyncComponent(() => import('@/components/api-reference/ApiReferenceView.vue'))
const RevisionsView = defineAsyncComponent(() => import('@/components/knowledge/RevisionsView.vue'))
const GraphView = defineAsyncComponent(() => import('@/components/knowledge/GraphView.vue'))

const { t } = useI18n()

const route = useRoute()
const auth = useAuthStore()
const layout = useLayoutStore()
const store = useDocumentsStore()
const events = useEventsStore()

const RAIL_WIDGETS = [
  // A spec's operations (#78): its table of contents, so it heads the rail on a
  // spec and does not exist on a page.
  { id: 'operations', label: t('apiRef.nav'), icon: ListTree, expandable: false },
  // What the page reads as and who answers for it (docs/features/39): a fact
  // about the page, so it heads the rail, and a widget like the rest so it
  // folds away and is remembered the same way.
  { id: 'verification', label: t('verification.title'), icon: BadgeCheck, expandable: false },
  { id: 'overview', label: t('rail.overview'), icon: Info, expandable: false },
  // Comments with no place on the text (#439): on the page as a whole, or on a
  // passage edited away. Only while there are any.
  { id: 'comments', label: t('rail.comments'), icon: MessageSquare, expandable: false },
  { id: 'frontmatter', label: t('rail.frontmatter'), icon: Braces, expandable: false },
  { id: 'revisions', label: t('rail.history'), icon: History, expandable: true },
  { id: 'merge-requests', label: t('rail.changes'), icon: GitMerge, expandable: true },
  // Reports against the page (docs/features/38, phase 3): what readers and
  // agents said is wrong, and where each report is on its way to a fix.
  { id: 'issues', label: t('rail.issues'), icon: Flag, expandable: false },
  // The auditor's newest score (#74): only once the page has one.
  { id: 'quality', label: t('rail.quality'), icon: Gauge, expandable: false },
  // Passages another page contradicts (#81): only while one is open.
  { id: 'conflicts', label: t('rail.conflicts'), icon: Scale, expandable: false },
  { id: 'graph', label: t('rail.graph'), icon: Share2, expandable: true },
  // How often the page is read and by whom — people, the assistant, agents (#79).
  { id: 'insights', label: t('rail.insights'), icon: Eye, expandable: false },
  // Where the code a component page declares is used (#236): only on a page
  // that declares one.
  { id: 'used-by', label: t('rail.usedBy'), icon: Network, expandable: false },
  { id: 'workflows', label: t('rail.workflows'), icon: WorkflowIcon, expandable: false },
  { id: 'connectors', label: t('rail.connectors'), icon: Plug, expandable: false },
  { id: 'activity', label: t('rail.activity'), icon: ActivityIcon, expandable: false },
] as const
type RailWidget = (typeof RAIL_WIDGETS)[number]['id']

const documentId = computed(() => route.params.id as string)

/**
 * Edits to this page kept in this browser and not yet published — the way
 * back to them from where people actually arrive. Read after mount: the SSR
 * pass has no storage, and deciding during render would not hydrate.
 */
const hasUnstaged = ref(false)
onMounted(() => {
  watch(
    documentId,
    (id) => {
      hasUnstaged.value = hasWorkingCopy(getWorkspaceId(), id)
    },
    { immediate: true },
  )
})

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
  RAIL_WIDGETS.filter(
    (w) =>
      (w.id !== 'frontmatter' || !!content.value?.frontmatter) &&
      (w.id !== 'used-by' || !!declaration.value) &&
      (w.id !== 'quality' || !!quality.value?.score) &&
      (w.id !== 'conflicts' || openConflicts.value > 0) &&
      (w.id !== 'comments' || unplacedThreads.value.length > 0) &&
      (w.id !== 'operations' || isSpec.value),
  ),
)

/** The widget currently blown up into the dialog, if any. */
const expanded = ref<RailWidget | null>(null)
const expandedWidget = computed(() => RAIL_WIDGETS.find((w) => w.id === expanded.value) ?? null)

const detail = ref<DocumentDetailResponse | null>(null)
const content = ref<DocumentContentResponse | null>(null)
const contentError = ref<string | null>(null)
const relations = ref<ListDocumentRelationsResponse['relations'] | null>(null)
const error = ref<string | null>(null)
/**
 * The API refused this page because it is restricted and the caller was not
 * granted (#76). Not an error — nothing broke — so it gets its own calm state
 * rather than the generic one. A guest is answered 404 instead, and lands in
 * the generic state like any missing page.
 */
const restrictedRefusal = ref(false)
/** "Access…" (#76): who may open this page. Every reader can look; managers edit. */
const accessOpen = ref(false)
// `?access=1` opens the dialog — an opening instruction (a comment on the
// merge request named someone who cannot open this page), not two-way state.
watch(
  () => route.query.access,
  (v) => {
    if (v === '1') accessOpen.value = true
  },
  { immediate: true },
)

/**
 * The template this page was created from (issue #69), named once the roster
 * knows it. The roster includes archived templates, so a page still names a
 * template nobody can start from any more.
 */
const templates = useTemplatesStore()
const templateRef = computed(() => detail.value?.document.templateRef ?? null)
watch(templateRef, (ref) => {
  if (ref) void templates.ensureLoaded()
})
const templateChip = computed(() => {
  const ref = templateRef.value
  if (!ref) return null
  const version = detail.value?.document.templateVersion ?? 1
  const name = templates.byRef(ref)?.name
  return name ? t('documents.fromTemplate', { name, version }) : t('documents.fromTemplateUnnamed', { version })
})
/** "Export…" (docs/features/45): a reader's act, so the menu is offered to every role. */
const exportOpen = ref(false)
/** The format the Export ▸ submenu picked (#441); the dialog opens on it. */
const exportFormat = ref<ExportFormat>('zip')
function openExport(format: ExportFormat) {
  exportFormat.value = format
  exportOpen.value = true
}
/** "Save as template": the page as it is shown — an older revision, when one is being read. */
const saveAsOpen = ref(false)
const saveAsPage = computed<SaveAsTemplatePage | null>(() => {
  if (!detail.value || !content.value) return null
  const fm = readFrontmatter(content.value.frontmatter)
  return {
    title: detail.value.document.title,
    body: content.value.markdown,
    category: detail.value.document.category,
    tags: fm.tags.split(',').map((tag) => tag.trim()).filter(Boolean),
    relations: fm.relations.map((r) => ({ type: r.type, target: r.key })),
    other: fm.other,
    projectId: detail.value.document.projectId,
  }
})
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

/* ---------------------------------------------------------- verification */

// The status bar (components/verification/VerificationBar, docs/features/39)
// owns the stamp, the flag, the owner and the archive state; this page only
// hands it the detail and takes the detail back. Archived pages are
// read-only: the Edit action goes, and the editor route sends you back here.
const archived = computed(() => !!detail.value?.document.archivedAt)

/* ------------------------------------------------------------ page data */

async function load() {
  try {
    const next = await apiFetch<DocumentDetailResponse>(`/v1/documents/${documentId.value}`)
    /*
     * Only when something actually moved. This runs every two seconds while a
     * revision is in flight, and again on every live event for this page — and
     * `detail` feeds the title, both badges, the meta line and all eight rail
     * previews. Assigning an equal-but-new object re-rendered that whole set on
     * a timer. The response is a handful of scalars, so comparing it whole is
     * cheaper than the render it avoids.
     */
    if (JSON.stringify(detail.value) !== JSON.stringify(next)) detail.value = next
    const status = next.revision.status
    if (status === 'indexed' || status === 'failed' || status === 'draft') {
      if (timer) clearInterval(timer)
      timer = undefined
    }
  } catch (e) {
    if (isRestrictedRefusal(e)) restrictedRefusal.value = true
    else error.value = (e as Error).message
    if (timer) clearInterval(timer)
  }
}

/** A saved restriction changes the lock here and on every row of the tree. */
function onAccessSaved() {
  void load()
  void store.invalidate()
}

/**
 * #81: `?asOf=` (a date, `tag:` or `rev:`) asks for the page as it read then.
 * The API picks the default-branch revision current at that point; from there
 * it is the ordinary read-only revision view. An explicit `?revision=` wins.
 */
const asOfParam = computed(() => (route.query.revision ? null : ((route.query.asOf as string | undefined) ?? null)))
const asOfRevision = ref<string | null>(null)
const asOfResolved = ref<ResolvedAsOf | null>(null)

async function loadContent() {
  contentError.value = null
  content.value = null
  try {
    const rev = route.query.revision
      ? `?revision=${route.query.revision as string}`
      : asOfParam.value
        ? `?asOf=${encodeURIComponent(asOfParam.value)}`
        : ''
    content.value = await apiFetch<DocumentContentResponse>(
      `/v1/documents/${documentId.value}/content${rev}`,
    )
    asOfRevision.value = asOfParam.value ? content.value.revisionId : null
    asOfResolved.value = asOfParam.value ? (content.value.resolvedAsOf ?? null) : null
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
/**
 * Threads the canvas cannot draw: no text anchor, or one whose passage is
 * gone. Stored and answerable like any other, so they are listed in the rail
 * rather than nowhere (#439).
 */
const unplacedThreads = computed(() =>
  threads.value.filter((t) => t.anchor?.type !== 'text' || outdatedThreads.value.includes(t.threadId)),
)
const unplacedOpen = computed(() => unplacedThreads.value.filter((t) => !t.resolved).length)

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
    { onSuccess: warnMentions, onError: (e) => toast.error(errorMessage(e, t)) },
  )
}
function onReply(threadId: string, body: string, replyToId: string | null = null) {
  replyThread.mutate(
    {
      path: { id: documentId.value, threadId },
      body: { body, ...(replyToId ? { replyToId } : {}) },
    },
    { onSuccess: warnMentions, onError: (e) => toast.error(errorMessage(e, t)) },
  )
}

/** Named people who cannot open this page were not told (#76): say so, and offer Access…. */
const { nameOf } = useMembers()
function warnMentions(data: unknown) {
  warnMentionedWithoutAccess(data, { t, nameOf, openAccess: () => (accessOpen.value = true) })
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
// #81: the rail row's count, and the same cache entry ConflictsRail reads.
const conflictsPreview = useQuery(
  computed(() => apiQueryOptions('/v1/conflicts', { query: { workspaceId: getWorkspaceId(), documentId: documentId.value } })),
)
const openConflicts = computed(
  () => ((conflictsPreview.data.value as ListConflictsResponse | undefined)?.conflicts ?? []).filter((c) => c.status === 'open').length,
)

const issuesPreview = useQuery(
  computed(() =>
    apiQueryOptions('/v1/knowledge-issues', {
      query: { workspaceId: getWorkspaceId(), documentId: documentId.value },
    }),
  ),
)

// The widget is drawn only once a score exists, so the preview query is also
// the widget's data — one request whether the row is open or not.
const qualityQuery = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/quality', { path: { id: documentId.value } })),
)
const quality = computed(() => qualityQuery.data.value as DocumentQualityResponse | undefined)

// Usage analytics (#79): the collapsed row previews the view count, so the
// page owns the query and the widget only draws.
const insightsQuery = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/insights', { path: { id: documentId.value } })),
)
const insights = computed(() => insightsQuery.data.value as PageInsightsResponse | undefined)

// The same query the declaration notice runs, which vue-query dedupes; the
// usages are read only once a declaration resolved to a connector.
const declarationPreview = useQuery(
  computed(() => apiQueryOptions('/v1/documents/{id}/component', { path: { id: documentId.value } })),
)
const declaration = computed(() => declarationPreview.data.value as ComponentDeclarationView | null | undefined)
const usagesPreview = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/documents/{id}/component/usages', { path: { id: documentId.value } }),
    enabled: !!declaration.value && !declaration.value.warning,
  })),
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
  const issues = (issuesPreview.data.value as ListKnowledgeIssuesResponse | undefined)?.issues
  const openIssues = issues?.filter((i) => isOpenIssueStatus(i.status)).length ?? 0

  return {
    // The collapsed row carries the state itself — the one word that decides
    // whether to open it.
    verification: detail.value
      ? archived.value
        ? t('verification.archived.badge')
        : t(`verification.state.${detail.value.document.verification ?? 'unverified'}`)
      : null,
    overview: detail.value ? `#${detail.value.revision.revisionNumber}` : null,
    operations: isSpec.value ? String(apiRef.operations.value.length) : null,
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
    conflicts: openConflicts.value ? String(openConflicts.value) : null,
    comments: unplacedOpen.value
      ? t('count.openComments', { n: unplacedOpen.value }, unplacedOpen.value)
      : t('count.threads', { n: unplacedThreads.value.length }, unplacedThreads.value.length),
    insights: insights.value ? t('analytics.viewsCount', { n: insights.value.views }, insights.value.views) : null,
    quality: quality.value?.score
      ? quality.value.stale
        ? t('quality.rail.previewStale', { n: quality.value.score.overall })
        : t('quality.rail.preview', { n: quality.value.score.overall })
      : null,
    issues: issues ? (openIssues ? t('count.openIssues', { n: openIssues }, openIssues) : t('knowledgeIssue.none')) : null,
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
    'used-by': (() => {
      const u = usagesPreview.data.value as CodeUsagesResponse | undefined
      if (declaration.value?.warning) return t('component.usedBy.unresolvedShort')
      if (!u) return null
      const n = u.usages.length + u.truncated
      return t('count.usages', { n }, n)
    })(),
  }
})

/* ------------------------------------------------------------- lifecycle */

const viewingRevision = computed(() => (route.query.revision as string | undefined) ?? asOfRevision.value)
// An API spec (#78) renders as a reference rather than a page, and is edited as text.
const isSpec = computed(() => !!detail.value?.document.kind && detail.value.document.kind !== 'page')
// One state for the rail's operation index and the main column's operation.
const apiRef = useApiReference(documentId, viewingRevision, isSpec)
const canComment = computed(() => auth.canComment && !viewingRevision.value)
// Usage analytics (#79): opening this page is one view, once it is known to be
// readable — a refused or missing page records nothing. The insights query
// started before the beacon, so it is read again once this visit is a row (#336).
usePageView(
  () =>
    detail.value ? { documentId: documentId.value, revisionId: viewingRevision.value ?? detail.value.revision.revisionId } : null,
  (id) => {
    if (id === documentId.value) void insightsQuery.refetch()
  },
)

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

watch([() => route.query.revision, () => route.query.asOf], () => void loadContent())

// Route reuse: navigating to a different document keeps this component alive.
watch(documentId, () => {
  detail.value = null
  content.value = null
  relations.value = null
  error.value = null
  restrictedRefusal.value = false
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
    if (!e || e.documentId !== documentId.value) return
    // Verification, ownership and archive events (docs/features/39) change
    // what the bar says and nothing else: the detail is re-read, the
    // content is not. Comments have their own query and are not re-read here.
    if (e.type.startsWith('document.')) {
      if (!e.type.startsWith('document.comment.')) void load()
      return
    }
    if (!e.type.startsWith('revision.')) return
    const before = detail.value?.revision.revisionId
    // Relations are re-extracted by any indexing pass, so they are always worth
    // re-reading. Content is not: a revision's bytes are immutable, so the only
    // thing that changes what this page says is a *different* head. Re-fetching
    // it regardless tore down and rebuilt the whole editor — losing the
    // selection, the scroll position and every comment decoration — each time a
    // cascade touched this page.
    void loadRelations()
    void load().then(() => {
      if (detail.value?.revision.revisionId !== before) void loadContent()
    })
  },
)
</script>

<template>
  <!-- The page's actions (#441), at the end of the trail's row: where you are
       on the left, what you can do to it on the right, one strip that stays
       put while the page scrolls. Only acts on the page itself — History and
       Graph live in the rail and Export in ⋯, so neither is said twice.
       Quiet first (who hears about it, who may open it, who else may), then
       the two verbs with their words, then ⋯. -->
  <Teleport to="#kn-page-actions">
    <template v-if="detail">
      <WatchButton subject-type="document" :subject-id="detail.document.documentId" compact />
      <!-- Handing the page to people outside the workspace is an editor's act
           (docs/features/43); the server checks the role and the workspace switch. -->
      <SharePopover
        v-if="auth.canEdit && !archived"
        :document-id="detail.document.documentId"
        :restricted="!!detail.document.restricted"
        compact
      />
      <!-- Who may open the page (#76). Offered to every reader: a manager
           edits it, anyone else is told where they stand. The icon is the
           page's state, so a restricted page reads as one from its row. -->
      <Button
        variant="ghost"
        size="icon-sm"
        :data-restricted="detail.document.restricted ? 'true' : undefined"
        :title="detail.document.restricted ? t('access.lockedLabel') : t('access.action')"
        :aria-label="detail.document.restricted ? t('access.lockedLabel') : t('access.action')"
        @click="accessOpen = true"
      >
        <Lock v-if="detail.document.restricted" class="size-4" aria-hidden="true" />
        <LockOpen v-else class="size-4" aria-hidden="true" />
      </Button>
      <span class="kn-bar-rule" aria-hidden="true" />
      <!-- Every reader can hand the page to an AI tool (issue #68). -->
      <PageAiActions
        :document-id="detail.document.documentId"
        :title="detail.document.title"
        :revision-id="viewingRevision"
      />
      <Button v-if="auth.canEdit && !archived" variant="outline" size="sm" as-child>
        <RouterLink
          :to="`/documents/${detail.document.documentId}/${isSpec ? 'spec' : 'edit'}`"
          :title="hasUnstaged ? t('editor.unstaged.label') : t('common.edit')"
        >
          <Pencil class="size-3.5" />
          <span class="kn-bar-label">{{ t('common.edit') }}</span>
          <span v-if="hasUnstaged" class="kn-dirty-dot" aria-hidden="true" />
          <span v-if="hasUnstaged" class="sr-only">{{ t('editor.unstaged.label') }}</span>
        </RouterLink>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <Button variant="ghost" size="icon-sm" :aria-label="t('documents.moreActions')" :title="t('documents.moreActions')">
            <MoreHorizontal class="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" class="w-52">
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Download class="size-4" /> {{ t('export.action') }}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="w-44">
              <DropdownMenuItem v-for="f in EXPORT_FORMATS" :key="f" @select="openExport(f)">
                {{ t(`export.format.${f}`) }}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem v-if="auth.canEdit && saveAsPage" @select="saveAsOpen = true">
            <LayoutTemplate class="size-4" /> {{ t('templates.saveAs.action') }}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <!-- Reader preferences, not page actions (#422): full width applies
               to every page and is remembered in a cookie. -->
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Eye class="size-4" /> {{ t('documents.menu.view') }}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="w-52">
              <DropdownMenuCheckboxItem :model-value="layout.fullWidth" @update:model-value="layout.setFullWidth">
                {{ t('documents.fullWidth') }}
              </DropdownMenuCheckboxItem>
              <!-- Only on pages that actually have vocabulary in them: a switch
                   for something the page does not do is noise. -->
              <DropdownMenuCheckboxItem
                v-if="canvasEl?.hasGlossary"
                :model-value="!!canvasEl?.glossaryOn"
                @update:model-value="canvasEl?.toggleGlossaryLinks()"
              >
                {{ t('glossary.toggleLinks') }}
              </DropdownMenuCheckboxItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
    </template>
  </Teleport>

  <RequestAccessCard v-if="restrictedRefusal" resource-type="document" :resource-id="documentId" />
  <PageState v-else-if="error" state="error" :description="error" />

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
        <Badge v-if="templateChip" variant="outline" class="text-muted-foreground gap-1 font-normal">
          <LayoutTemplate class="size-3" aria-hidden="true" />
          {{ templateChip }}
        </Badge>
      </template>


      <template #meta>
        <p class="text-xs text-muted-foreground">
          {{ t('documents.revisionNumber', { n: detail.revision.revisionNumber }) }}
          <span class="font-mono">({{ detail.revision.revisionId.slice(0, 8) }})</span>
          <template v-if="detail.revision.finalizedAt">
            · {{ t('documents.finalizedAt', { when: formatDateTime(detail.revision.finalizedAt) }) }}
          </template>
        </p>
        <CollabDraftBadge :document-id="documentId" :branch="detail.document.defaultBranch" context="page" />
      </template>

      <!-- Rail: everything about the page rather than in it ------------- -->
      <template #rail>
        <PageRail
          :widgets="visibleWidgets"
          surface="document"
          :default-open="['operations', 'verification', 'overview', 'comments']"
          :previews="previewFor"
          @expand="expanded = $event"
        >
          <!-- Above the stack and outside it: the contents belong to the page
               being read, not to the facts about it. -->
          <template #before>
            <TocRail v-if="!isSpec && headings.length > 1" :headings="headings" />
          </template>

          <!-- Hidden while reading an old revision: the stamp is about the head. -->
          <template #widget-operations><ApiOperationIndex :state="apiRef" /></template>
          <template #widget-verification>
            <VerificationBar
              v-if="!viewingRevision"
              :detail="detail"
              @update:detail="detail = $event"
              @reload="load()"
            />
            <p v-else class="text-xs text-muted-foreground">{{ t('verification.headOnly') }}</p>
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
                  :title="t('documents.provenance', { extractor: r.provenance.extractor, confidence: r.provenance.confidence })"
                >
                  <span class="text-muted-foreground">{{ r.type }}</span>
                  <span class="font-medium">{{ r.to.name }}</span>
                </span>
                <button
                  v-if="relations.length > RELATION_PREVIEW"
                  class="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                  @click="showAllRelations = !showAllRelations"
                >
                  {{ showAllRelations ? t('common.showFewer') : t('common.andNMore', { n: relations.length - RELATION_PREVIEW }) }}
                </button>
              </div>
            </div>
          </template>

          <template #widget-comments>
            <p class="mb-2 text-xs text-muted-foreground">{{ t('documents.unplacedCommentsHint') }}</p>
            <div class="space-y-2">
              <ThreadCard
                v-for="thread in unplacedThreads"
                :key="thread.threadId"
                :thread="thread"
                :outdated="outdatedThreads.includes(thread.threadId)"
                :readonly="!canComment"
                :busy="threadsBusy"
                :resolve-document-id="resolveDocumentId"
                teach-kind="document-thread"
                @reply="(b: string, p: string | null) => onReply(thread.threadId, b, p)"
                @resolve="(r: boolean) => onResolve(thread.threadId, r)"
                @edit="(c: string, b: string) => onEditComment(thread.threadId, c, b)"
                @delete="(c: string) => onDeleteComment(thread.threadId, c)"
              />
            </div>
          </template>

          <template #widget-frontmatter>
            <pre class="overflow-x-auto rounded bg-muted/40 p-2 text-xs">{{ JSON.stringify(content?.frontmatter, null, 2) }}</pre>
          </template>

          <template #widget-revisions><RevisionsView :document-id="documentId" /></template>
          <template #widget-merge-requests><MergeRequestList :document-id="documentId" /></template>
          <template #widget-conflicts>
            <ConflictsRail :document-id="documentId" />
          </template>
          <template #widget-issues>
            <KnowledgeIssuesRail
              :document-id="documentId"
              :title="detail.document.title"
              :revision-id="content?.revisionId ?? detail.revision.revisionId"
            />
          </template>
          <template #widget-quality>
            <QualityRail v-if="quality?.score" :quality="quality" />
          </template>
          <template #widget-graph><GraphView :document-id="documentId" /></template>
          <template #widget-insights>
            <PageInsightsRail v-if="insights" :insights="insights" />
          </template>
          <template #widget-used-by>
            <UsedByRail
              :document-id="documentId"
              :project-id="detail?.document.projectId"
              :parent-id="detail?.document.parentId"
            />
          </template>
          <template #widget-workflows><WorkflowRail :document-id="documentId" /></template>
          <template #widget-connectors>
            <ConnectorRail
              :document-id="documentId"
              :drift-check="detail?.document.kind === 'openapi' && auth.canEdit && !archived && !viewingRevision"
            />
          </template>
          <!-- Bounded to sit inside the widget's own cap rather than past it.
               Left at the 60vh default, the feed's scrollport was taller than
               the card holding it, so the rail scrolled the card while the card
               scrolled the feed — two scrollbars for one list, and the paging
               sentinel on whichever one you were not using. One scrollport, and
               the virtualizer keeps it to the rows on screen however long the
               history gets. -->
          <template #widget-activity>
            <ActivityFeed :document-id="documentId" height="18rem" />
          </template>

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
        <!-- #81: as of a point — the date, the tag when it was one, and the
             revision that was the page then. A note, not an alert: the page is
             fine, the reader asked for its past. -->
        <p v-if="asOfResolved && viewingRevision" class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <History class="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {{ asOfResolved.kind === 'tag'
              ? t('documents.asOfBannerTag', { date: formatDate(asOfResolved.at), tag: asOfResolved.ref.slice(4) })
              : t('documents.asOfBanner', { date: formatDate(asOfResolved.at) }) }}
          </span>
          <span class="font-mono">({{ viewingRevision.slice(0, 8) }})</span>
          <RouterLink :to="`/documents/${documentId}`" class="underline">{{ t('documents.backToHead') }}</RouterLink>
        </p>
        <p v-else-if="viewingRevision" class="text-xs text-muted-foreground">
          {{ t('documents.viewingRevision', { id: viewingRevision.slice(0, 8) }) }}
          <RouterLink :to="`/documents/${documentId}`" class="underline">{{ t('documents.backToHead') }}</RouterLink>
        </p>
        <!-- About the head, like the verification stamp. -->
        <ComponentDeclarationNotice v-if="!viewingRevision" :document-id="documentId" />
        <ApiReferenceView v-if="isSpec" :state="apiRef" :workspace-id="detail.document.workspaceId" />
        <PageState v-else-if="contentError" state="error" :description="contentError" />
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
          <!-- Sized under the dialog's own 70vh so the feed keeps the scroll,
               for the same reason it does in the rail. -->
          <ActivityFeed v-else-if="expanded === 'activity'" :document-id="documentId" height="56vh" />
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

    <SaveAsTemplateDialog v-model:open="saveAsOpen" :page="saveAsPage" />
    <ExportDialog
      v-model:open="exportOpen"
      :initial-format="exportFormat"
      :target="{ kind: 'document', documentId: detail.document.documentId, title: detail.document.title }"
    />
    <PageAccessDialog
      v-model:open="accessOpen"
      resource-type="document"
      :resource-id="detail.document.documentId"
      :title="detail.document.title"
      @saved="onAccessSaved"
    />
  </template>
</template>
