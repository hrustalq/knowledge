<script setup lang="ts">
// Feature 03 (docs/features/03): the page editor.
//
// WYSIWYG on Tiptap, but the *stored* format is still markdown — RichEditor
// converts both ways. That keeps every backend behaviour intact (heading-aware
// chunking, frontmatter relations, structural diff, merge requests, the graph)
// while the authoring experience changes completely.
//
// Metadata that is not the page itself — project, parent, category, relations,
// tags — lives in a settings sheet rather than a form above the content, so
// what is on screen while you write is the page and nothing else.
//
// The assistant lives in a panel on the right (docs/features/34), beside the
// page it is changing. It reads the draft as it stands and
// writes into it as suggestions — see EditorAiPanel and extensions/ai-suggestions.
//
// Edits are a working copy until published (lib/working-copy): kept in this
// browser as they are made, restored when the page is reopened, reviewable as
// a diff against the published head, and discarded only on request.
//
// With COLLAB_ENABLED on, an existing page is edited as a shared draft (#80,
// docs/features/56): the body and the page fields live in a Y.Doc everyone on
// the page edits at once, the working copy steps aside for the draft's own
// copy on this device, and publishing is unchanged.
//
// An existing, published page is edited on its author's private working
// branch (#474, docs/features/66): Save draft writes a revision only they and
// who they share it with can read, and Publish merges it onto the page — or
// opens a merge request when a gate holds it.
//
// A new page can start from a template (issue #69): `/create?template=` opens
// on the skeleton the gallery rendered, and the template is sent as provenance
// when the page is created. `/template` inserts one at the cursor of any page,
// and "Save as template" goes the other way.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue'
import { RouterLink, onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { onKeyStroke, useStorage } from '@vueuse/core'
import { useQueryClient } from '@tanstack/vue-query'
import {
  Eye,
  FilePlus2,
  GitCompareArrows,
  History,
  LayoutTemplate,
  MoreHorizontal,
  NotepadTextDashed,
  Route,
  Save,
  Settings2,
  Sparkles,
  Undo2,
  UserPlus,
  X,
} from 'lucide-vue-next'
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  DRAFT_BRANCH_PREFIX,
  collabDocName,
  type CollabCapabilitiesResponse,
  type CompareResponse,
  type DocumentCategory,
  type DocumentContentResponse,
  type DocumentDetailResponse,
  type BranchInfo,
  type FinalizeRevisionResponse,
  type ListBranchesResponse,
  type ListCollabDraftsResponse,
  type RenderTemplateResponse,
} from '@knowledge/contracts'
import { SCHEMA_VERSION, editorSchema, parseMarkdown } from '@knowledge/editor-schema'
import { getWorkspaceId } from '@/shared/api/api'
import { api, fetchApi, isApiRequestError } from '@/shared/api/queries'
import { errorDetails, errorMessage, errorReason } from '@/shared/api/errors'
import { presignedPut } from '@/shared/api/presigned-put'
import { labelFor } from '@/shared/i18n/labels'
import { formatDateTime } from '@/shared/utils/format'
import { lineDiff } from '@/core/line-diff'
import { buildSource, mergeTemplateDefaults, readFrontmatter, samePage, type PageFields, type RelationRow, type TemplateProvenance } from '@/entities/document'
import { readWorkingCopy, removeWorkingCopy, workingCopyKey, type WorkingCopy } from '@/entities/rich-editor'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useTemplatesStore } from '@/entities/template'
import { useEventsStore } from '@/stores/events'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Checkbox } from '@/shared/ui/checkbox'
import { Skeleton } from '@/shared/ui/skeleton'
import { PageState } from '@/shared/layout'
import { Autocomplete, type AutocompleteOption } from '@/shared/ui/autocomplete'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/shared/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/shared/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { RichEditor } from '@/entities/rich-editor'
import { EMBED_DOCUMENT } from '@/entities/rich-editor'
import { ApiOperationPicker, type PickedOperation } from '@/entities/api-operation'
import { ApiOperationRef } from '@/entities/api-operation'
import { SaveAsTemplateDialog, type SaveAsTemplatePage } from '@/entities/template'
import { useWorkingCopy } from '@/modules/editor/model/use-working-copy'
import { docToMarkdown } from '@/entities/rich-editor'
import type { CollabHandle } from '@/entities/rich-editor'
import { loadCollab } from '@/entities/rich-editor'
import CollabStatus from '@/modules/editor/components/CollabStatus.vue'
import CollabPresence from '@/modules/editor/components/CollabPresence.vue'
import { DiffView } from '@/entities/document'
import EditorAiPanel from '@/modules/editor/components/EditorAiPanel.vue'
import { PageAccessDialog } from '@/entities/access'
import { connectDraft } from '@/entities/assistant'
import { useSidebarStore } from '@/stores/sidebar'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()
const store = useDocumentsStore()
const projects = useProjectsStore()
const templates = useTemplatesStore()
const auth = useAuthStore()

const editId = ref<string | null>((route.params.id as string | undefined) ?? null)
// Embed groups show the snapshots of what this page has published (#470).
provide(EMBED_DOCUMENT, editId)
const isEdit = computed(() => editId.value !== null)
// A new page is born a private draft (#474), so saving it publishes to nobody
// but its author; the page itself offers Publish. An existing page is read on
// load, and until then (or when the load fails) is taken as published.
const isDraft = ref(editId.value === null)

const title = ref('')
const category = ref<DocumentCategory>('other')
const parentId = ref<string>('')
// Workspace > Project > Document: on /create this seeds from the active
// project; when editing it doubles as the move control.
const projectId = ref<string>(projects.activeId ?? '')
const body = ref('')
const message = ref('')
const relationRows = ref<RelationRow[]>([])
const tags = ref('')
/** The template this new page started from, recorded when it is created. */
const template = ref<TemplateProvenance | null>(null)
/**
 * Every frontmatter key this editor does not model.
 *
 * The settings sheet offers `relations:` and `tags:`, but a page's frontmatter
 * routinely carries more — `source:` is written by every connector adapter, and
 * `glossary: false` turns term linking off for a page (DocumentCanvas reads it).
 * `buildSource` rebuilt the block from the two fields on screen, so everything
 * else was silently destroyed on every save, on both the create and edit paths.
 * Held here on load and re-emitted verbatim instead.
 */
const otherFrontmatter = ref<Record<string, unknown>>({})
const headRevisionId = ref<string | null>(null)
/**
 * `?branch=<name>` (#80): edit that branch rather than the default one — a
 * proposed change several people shape before it becomes a merge request.
 * Read once; an unknown name falls back to the default branch.
 */
const requestedBranch = typeof route.query.branch === 'string' ? route.query.branch : null
/** The branch being edited, once loaded. Null on a new page. */
const branch = ref<BranchInfo | null>(null)
/** `branch`'s name when it is not the page's default: its working copy has a slot of its own. */
const branchSlot = ref<string | null>(null)
/**
 * A working branch (#474): the caller's own, or one its owner shared with
 * them. Saving writes a private revision; Publish merges it onto the page.
 */
const onWorkingBranch = computed(() => !isDraft.value && !!branch.value?.name.startsWith(DRAFT_BRANCH_PREFIX))
/** Who it is shared with is its owner's to change, or an admin's — as the API has it. */
const canShareBranch = computed(
  () => onWorkingBranch.value && (branch.value?.ownerId === auth.me?.userId || auth.canAdminWorkspace),
)
const shareOpen = ref(false)

/**
 * `/create?parent=&project=&template=` (issue #69): where a new page goes and
 * what it starts from. An opening instruction, like `?tab=` — read once, then
 * dropped from the address, because from then on the working copy is what
 * remembers the page, provenance included.
 *
 * Placement is read during setup so the server paints the right parent and
 * project; the template is applied once the editor is ready (`openTemplate`).
 */
let openingTemplate: string | null = null

function readOpening(): boolean {
  if (isEdit.value) return false
  const param = (name: string) => (typeof route.query[name] === 'string' ? (route.query[name] as string) : '')
  const parent = param('parent')
  const project = param('project')
  const ref = param('template')
  if (!parent && !project && !ref) return false
  if (project) projectId.value = project
  if (parent) parentId.value = parent
  openingTemplate = ref || null
  return true
}
/** An instruction arrived with this visit, so a stored new-page draft is offered, not restored over it. */
const opened = readOpening()

/**
 * A draft revision created by `ensureDocumentId` and not yet written to.
 *
 * Dropping an image into an unsaved page creates the document early, which
 * leaves an empty draft revision behind. Without claiming it here, the next
 * save would take the edit path and open a *second* revision, orphaning the
 * first.
 */
const pendingRevisionId = ref<string | null>(null)
const busy = ref(false)
/**
 * Starts true on an edit route. It used to start false and flip in
 * `onMounted`, so the editor mounted once with an empty page, was torn down for
 * the skeleton and mounted again — and the working copy would take that empty
 * first mount for the published baseline.
 */
const loading = ref(isEdit.value)
/**
 * Why the page being edited did not load (#314). While set, the editor is not
 * mounted, nothing is stored as a working copy and Publish is refused: the
 * fields are empty, and publishing them would finalize a blank page over the head.
 */
const loadError = ref<unknown>(null)
const settingsOpen = ref(false)
const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)

/* ------------------------------------------------------- assistant */

const sidebar = useSidebarStore()
const features = useFeaturesStore()
/** Its chat is the Assistant's threads: switched off with the Assistant (#604). */
const aiAvailable = computed(() => features.isOn('assistant'))
/** Cookie-backed, so the server paints the panel where the author left it. */
const aiOpen = computed(() => aiAvailable.value && sidebar.aiPanelOpen)
/**
 * Mounted on first open and kept after: closing keeps the conversation and its
 * scroll where they were, and a page whose panel was never opened never loads
 * the chat roster.
 */
const aiMounted = ref(aiOpen.value)
const aiPanel = ref<InstanceType<typeof EditorAiPanel> | null>(null)

function setAiOpen(open: boolean) {
  if (open && !aiAvailable.value) return
  if (open) aiMounted.value = true
  sidebar.setAiPanel(open)
  if (open) void nextTick(() => aiPanel.value?.focus())
}

// ⌘J / Ctrl+J, from anywhere on the page — the chord Notion and Confluence
// both use for their writing assistant, so a hand that knows one finds it here.
onKeyStroke('j', (event) => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
  event.preventDefault()
  setAiOpen(!aiOpen.value)
})

/** Server renders Ctrl; the browser corrects it after hydration rather than mismatching. */
const modKey = ref('Ctrl+')
onMounted(() => {
  if (/Mac|iPhone|iPad/.test(navigator.platform)) modKey.value = '⌘'
})

const EMPTY_PENDING = { count: 0, streaming: false }
const aiPending = computed(() => editorRef.value?.aiPending ?? EMPTY_PENDING)

// While the editor is mounted every turn the store sends carries the draft,
// and every edit it streams back lands here — whichever control started the
// turn. Registered on mount, so a server render never holds one.
let disconnectDraft: (() => void) | null = null
onMounted(() => {
  disconnectDraft = connectDraft({
    read: () => ({
      title: title.value,
      markdown: editorRef.value?.flush() ?? body.value,
      // A new page started from a template is a skeleton to fill (issue #69);
      // once published it is a page like any other, and the turn says so.
      ...(!isEdit.value && template.value ? { template: template.value } : {}),
    }),
    edit: (edit) => {
      // The author asked for this; make sure they can watch it happen.
      if (!aiOpen.value) setAiOpen(true)
      editorRef.value?.applyAiEdit(edit)
    },
    settle: () => editorRef.value?.settleAi(),
  })
})
onBeforeUnmount(() => disconnectDraft?.())

// The settings fields are the same Autocomplete the search filters use, so a
// long project or page roster is typed-into rather than scrolled — and the
// two places you pick a project in this app behave identically. It speaks
// string[]; these adapters bridge that to the single values held here.
const TOP_LEVEL = '__root__'

function single(get: () => string, set: (v: string) => void) {
  return computed<string[]>({
    get: () => (get() ? [get()] : []),
    set: (v) => set(v[0] ?? ''),
  })
}

const projectSelection = single(() => projectId.value, (v) => (projectId.value = v))
const categorySelection = single(() => category.value, (v) => (category.value = (v || 'other') as DocumentCategory))
const parentSelection = computed<string[]>({
  get: () => [parentId.value || TOP_LEVEL],
  set: (v) => {
    parentId.value = v[0] === TOP_LEVEL ? '' : (v[0] ?? '')
  },
})

const relationTypeOptions: AutocompleteOption[] = AUTHORABLE_RELATION_TYPES.map((t) => ({ value: t, label: t }))

/** A row whose key names a spec operation (#78) — shown resolved under its input. */
const isOperationKey = (key: string) => /^\s*(op|channel)\s*:/iu.test(key)

/**
 * "Link API operation" (#78): a use case IMPLEMENTS the endpoint it is built
 * on, so that is the type it arrives with; the select changes it. The key is
 * the one the spec's ingestion wrote, never retyped.
 */
function linkOperation(op: PickedOperation) {
  if (relationRows.value.some((r) => r.key.trim() === op.entityKey)) return
  relationRows.value.push({ type: 'IMPLEMENTS', key: op.entityKey, name: `${op.method ?? ''} ${op.path}`.trim() })
}

const projectOptions = computed<AutocompleteOption[]>(() =>
  projects.items.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount })),
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: labelFor(t, 'category', c) })),
)
const parentOptions = computed<AutocompleteOption[]>(() => [
  { value: TOP_LEVEL, label: t('documents.topLevel') },
  ...store.items
    .filter((d) => d.documentId !== editId.value)
    .map((d) => ({ value: d.documentId, label: d.title, meta: d.category })),
])

const mentionablePages = computed(() =>
  store.items
    .filter((d) => d.documentId !== editId.value)
    .map((d) => ({ documentId: d.documentId, title: d.title, category: d.category })),
)


/* ------------------------------------------------------ working copy */

/** The page as the editor holds it right now. Reads every field, so a watch tracks all of them. */
function currentFields(): PageFields {
  return {
    title: title.value,
    body: body.value,
    category: category.value,
    parentId: parentId.value,
    projectId: projectId.value,
    relations: relationRows.value.map((r) => ({ type: r.type, key: r.key, name: r.name })),
    tags: tags.value,
    message: message.value,
    template: template.value,
  }
}

function applyFields(fields: PageFields) {
  title.value = fields.title
  body.value = fields.body
  category.value = fields.category as DocumentCategory
  parentId.value = fields.parentId
  projectId.value = fields.projectId
  relationRows.value = fields.relations.map((r) => ({ ...r }))
  tags.value = fields.tags
  message.value = fields.message
  template.value = fields.template ?? null
}

/**
 * The published page, as the editor normalises it — captured once the editor
 * has parsed it (`onEditorReady`), so a page whose stored markdown is not the
 * editor's own spelling of it does not read as changed the moment it opens.
 */
const baseFields = ref<PageFields | null>(null)

const storageKey = computed(() => workingCopyKey(getWorkspaceId(), editId.value, branchSlot.value))

/* ------------------------------------------------------ shared draft */

/** The page's shared draft, once joined (#80). `null` edits alone, exactly as before. */
const collab = shallowRef<CollabHandle | null>(null)
let unbindFields: (() => void) | null = null
/** A working copy from before this page was edited live, offered once, applied only on a click. */
const localCopy = ref<WorkingCopy | null>(null)

/** How long joining may hold the skeleton before the page opens single-user instead. */
const COLLAB_JOIN_TIMEOUT_MS = 10_000

/**
 * The published page as the editor would write it: what "unpublished" is
 * measured against in a shared draft. The editor itself only ever holds the draft.
 */
function publishedFields(page: DocumentDetailResponse['document'], content: DocumentContentResponse): PageFields {
  const fm = readFrontmatter(content.frontmatter)
  return {
    title: page.title,
    body: docToMarkdown(parseMarkdown(content.markdown, document), editorSchema),
    category: page.category,
    parentId: page.parentId ?? '',
    projectId: page.projectId,
    relations: fm.relations,
    tags: fm.tags,
    message: '',
    template: null,
  }
}

/**
 * Join the branch's shared draft and hold the editor until it is here to
 * show. Anything short of that — a refusal, a socket that never opens — leaves
 * the page as it always was: single-user, working copy and all.
 */
async function startCollab(
  detail: DocumentDetailResponse,
  content: DocumentContentResponse,
  on: BranchInfo,
  caps: CollabCapabilitiesResponse,
) {
  const doc = detail.document
  // Loaded only here: a deployment that does not co-edit never fetches Yjs.
  const { createCollab, bindPageFields, META_FIELD } = await loadCollab()
  const handle = createCollab({
    name: collabDocName(doc.workspaceId, doc.documentId, on.branchId),
    schemaMatches: caps.schemaVersion === SCHEMA_VERSION,
    me: auth.me ? { userId: auth.me.userId, name: auth.me.displayName } : null,
  })
  const ready = await Promise.race([
    handle.ready,
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), COLLAB_JOIN_TIMEOUT_MS)),
  ])
  if (!ready) {
    handle.destroy()
    toast.info(t('editor.collab.unavailable'))
    return
  }
  baseFields.value = publishedFields(doc, content)
  collab.value = handle
  const bind = () => {
    if (collab.value !== handle) return
    unbindFields = bindPageFields(handle.doc, {
      texts: { title, tags, message },
      values: { category, parentId, projectId, relations: relationRows },
    })
  }
  // Fields the draft lacks are seeded from what was loaded, which only the
  // server's copy can say: this device's copy may predate them.
  if (handle.doc.getMap(META_FIELD).size > 0) bind()
  else void handle.synced.then(bind)
}

onBeforeUnmount(() => {
  unbindFields?.()
  collab.value?.destroy()
})

/**
 * The branch was published past the draft by another path — MCP, a merge, a
 * connector — so publishing it as it stands would silently undo that change.
 * Holds the head it moved to; the review then compares the draft against it.
 */
const headMoved = ref<string | null>(null)

/**
 * Bring the baseline level with the branch head after someone published. From
 * this draft (its base is the head): nothing more to say — the chip clears.
 * From elsewhere: the head-moved notice, with the review showing what changed.
 */
async function followHead() {
  if (!collab.value || !editId.value || !branch.value) return
  const id = editId.value
  const path = { id }
  const [{ branches }, { drafts }, detail] = (await Promise.all([
    fetchApi(queryClient, '/v1/documents/{id}/branches', { path }, { fresh: true }),
    fetchApi(queryClient, '/v1/documents/{id}/drafts', { path }, { fresh: true }),
    fetchApi(queryClient, '/v1/documents/{id}', { path }, { fresh: true }),
  ])) as [ListBranchesResponse, ListCollabDraftsResponse, DocumentDetailResponse]
  const head = branches.find((b) => b.branchId === branch.value?.branchId)?.headRevisionId ?? null
  const draft = drafts.find((d) => d.branchId === branch.value?.branchId)
  if (!head || !draft || head === headRevisionId.value) return
  const content = await fetchApi(queryClient, '/v1/documents/{id}/content', {
    path,
    query: { revision: head },
  })
  baseFields.value = publishedFields(detail.document, content)
  otherFrontmatter.value = readFrontmatter(content.frontmatter).other
  headRevisionId.value = head
  headMoved.value = draft.baseRevisionId === head ? null : head
}

const events = useEventsStore()
watch(
  () => events.lastEvent,
  (e) => {
    if (e?.type === 'revision.finalized' && e.documentId === editId.value) void followHead().catch(() => {})
  },
)

/** Throw the shared draft away for everyone, back to the branch head. Every peer — this tab too — rejoins. */
const discardOpen = ref(false)
/** From the review: one modal at a time, or the question opens underneath the diff. */
function askDiscard() {
  reviewOpen.value = false
  discardOpen.value = true
}
async function discardDraft() {
  discardOpen.value = false
  reviewOpen.value = false
  if (!editId.value || !branch.value) return
  try {
    await api.delete('/v1/documents/{id}/drafts/{branchId}', {
      path: { id: editId.value, branchId: branch.value.branchId },
    })
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/**
 * Someone discarded the draft (`reset`): this tab's Y.Doc and this device's
 * copy are the old draft, and merging either into the reseeded one would
 * show the page twice. Drop both and open the page again from the start.
 */
watch(
  () => collab.value?.status.reason,
  async (reason) => {
    const handle = collab.value
    if (reason !== 'reset' || !handle) return
    loading.value = true
    unbindFields?.()
    unbindFields = null
    collab.value = null
    headMoved.value = null
    await handle.forget()
    toast.info(t('editor.collab.reset'))
    await loadPage()
  },
)

function offerLocalCopy() {
  const stored = readWorkingCopy(storageKey.value)
  const base = baseFields.value
  if (!stored || !base) return
  if (samePage(stored, base)) removeWorkingCopy(storageKey.value)
  else localCopy.value = stored
}

/** The old copy, laid over the shared draft as one ordinary edit everyone receives. */
function applyLocalCopy() {
  const stored = localCopy.value
  localCopy.value = null
  if (!stored) return
  applyFields(stored)
  editorRef.value?.replaceContent(stored.body)
  removeWorkingCopy(storageKey.value)
}

function discardLocalCopy() {
  localCopy.value = null
  removeWorkingCopy(storageKey.value)
}

const workingCopy = useWorkingCopy({
  // A shared draft keeps its own copy on this device (IndexedDB); a second,
  // per-browser one restored into it would be a second seed. Loading suspends
  // it too: reopening after a reset lays the new head over the last session's
  // baseline, and storing that would offer the published page back as edits.
  key: () => (collab.value || loading.value || loadError.value ? null : storageKey.value),
  fields: currentFields,
  base: () => {
    const base = baseFields.value
    // A page that does not exist yet has no project or parent to move from:
    // picking one (or the active project arriving late, or a "New child page"
    // arriving on an open editor) is placement, not an edit worth keeping.
    return base && !isEdit.value ? { ...base, projectId: projectId.value, parentId: parentId.value } : base
  },
  documentId: () => editId.value,
  baseRevisionId: () => headRevisionId.value,
  beforeFlush: () => editorRef.value?.flush(),
})
const unstaged = workingCopy.unstaged

/** A stored copy made against an older head, waiting for the author to decide. */
const staleCopy = ref<WorkingCopy | null>(null)

function onEditorReady() {
  if (collab.value) {
    // Brings `body` level with the draft; the baseline is the published head.
    editorRef.value?.flush()
    offerLocalCopy()
    return
  }
  if (baseFields.value) return
  // Flushing sets `body` to the editor's normalised form of what was loaded.
  editorRef.value?.flush()
  baseFields.value = { ...currentFields(), message: '' }
  offerWorkingCopy()
  void followOpening()
}

/**
 * Put back the edits this browser was keeping — automatically when they were
 * made against the page as it is now, and only on request when it has been
 * published since: restoring those silently and publishing would quietly undo
 * whoever published in between.
 */
function offerWorkingCopy() {
  const stored = readWorkingCopy(storageKey.value)
  const base = baseFields.value
  if (!stored || !base) return
  if (samePage(stored, base)) {
    removeWorkingCopy(storageKey.value)
    return
  }
  // A new page asked for by a link — a parent, a template — is not the draft
  // this browser was keeping: that one is offered, not restored over it.
  if (stored.baseRevisionId === headRevisionId.value && !opened) {
    applyFields(stored)
    workingCopy.adopt(stored)
    toast.info(t('editor.unstaged.restored', { when: formatDateTime(new Date(stored.savedAt)) }))
    return
  }
  staleCopy.value = stored
}

function restoreStale() {
  const stored = staleCopy.value
  staleCopy.value = null
  if (!stored) return
  applyFields(stored)
  workingCopy.adopt(stored)
}

function discardStale() {
  staleCopy.value = null
  removeWorkingCopy(storageKey.value)
}

/** Back to the published page: the fields, and the stored copy with them. */
function discardUnstaged() {
  if (baseFields.value) applyFields(baseFields.value)
  workingCopy.discard()
  reviewOpen.value = false
}

/* --------------------------------------------------------- templates */

/**
 * Lay a rendered template over the page. The gallery's render is used when it
 * made one; a reload or a pasted link renders here instead, and when that
 * needs values only the gallery asks for, the gallery opens on the template.
 *
 * Nothing already on the page is replaced: a title or text typed before the
 * template arrived stays, with the skeleton after it, and tags and relations
 * are a union (`mergeTemplateDefaults`).
 */
async function openTemplate(ref: string) {
  let rendered = templates.takeRendered(ref)
  if (!rendered) {
    try {
      rendered = await api.post('/v1/templates/render', {
        body: {
          workspaceId: getWorkspaceId(),
          ref,
          ...(title.value.trim() ? { title: title.value.trim() } : {}),
          ...(projectId.value ? { projectId: projectId.value } : {}),
          ...(parentId.value ? { parentId: parentId.value } : {}),
        },
      })
    } catch (e) {
      toast.error(errorMessage(e, t))
      templates.openGallery({ ref, parentId: parentId.value || null, projectId: projectId.value || null })
      return
    }
  }
  const fm = readFrontmatter(rendered.frontmatter)
  const page = editorRef.value?.flush() ?? body.value
  applyFields({
    ...mergeTemplateDefaults(currentFields(), { category: rendered.category, relations: fm.relations, tags: fm.tags }),
    title: title.value.trim() ? title.value : rendered.title,
    body: page.trim() ? `${page.trimEnd()}\n\n${rendered.body}` : rendered.body,
    template: { ref: rendered.templateRef, version: rendered.templateVersion },
  })
  otherFrontmatter.value = { ...fm.other, ...otherFrontmatter.value }
}

/** Act on the visit's opening instruction once the editor can take it, then drop it from the address. */
async function followOpening() {
  const ref = openingTemplate
  openingTemplate = null
  if (route.query.template || route.query.parent || route.query.project) {
    await router.replace({ path: route.path, hash: route.hash })
  }
  if (!ref) return
  // Taken before rendering, so a render that fails and reopens the gallery
  // does not leave the request behind for some later visit to send.
  const prompt = templates.takeFill(ref)
  await openTemplate(ref)
  if (prompt && template.value?.ref === ref) await fillWithAi(prompt)
}

/**
 * "Describe the page for AI" (issue #69): open the assistant on the skeleton
 * and send the description as the first turn. The draft bridge carries the
 * page and its template, so what comes back is `edit_draft` suggestions in
 * the template's sections — nothing is kept until the author accepts it, and
 * nothing is saved until they publish.
 */
async function fillWithAi(prompt: string) {
  setAiOpen(true)
  // The panel mounts on first open; the skeleton reaches the editor on the same tick.
  await nextTick()
  await aiPanel.value?.fill(prompt)
}

// The editor is reused when a new instruction arrives while it is open — the
// tree's "New page from template" while on /create — so it is read again here.
watch(
  () => route.query,
  () => {
    if (baseFields.value && readOpening()) void followOpening()
  },
)

/** Where a `/template` insert renders against: the page as it stands. */
const templateContext = computed(() => ({
  title: title.value.trim(),
  parentId: parentId.value || null,
  projectId: projectId.value || null,
}))

/**
 * `/template` put a skeleton at the cursor; lay its tags, relations and
 * category over the page the way the gallery's render is (`mergeTemplateDefaults`).
 * A new page that held nothing else was started from the template, so it is
 * recorded as provenance too; a section added to a page already being written
 * is not where that page came from.
 */
function applyInsertedTemplate(rendered: RenderTemplateResponse, intoEmptyPage: boolean) {
  const fm = readFrontmatter(rendered.frontmatter)
  const merged = mergeTemplateDefaults(currentFields(), { category: rendered.category, relations: fm.relations, tags: fm.tags })
  category.value = merged.category as DocumentCategory
  relationRows.value = merged.relations
  tags.value = merged.tags
  otherFrontmatter.value = { ...fm.other, ...otherFrontmatter.value }
  if (intoEmptyPage && !isEdit.value && !template.value) {
    template.value = { ref: rendered.templateRef, version: rendered.templateVersion }
    if (!title.value.trim()) title.value = rendered.title
  }
}

/* ---------------------------------------------------- save as template */

const saveAsOpen = ref(false)
const saveAsPage = ref<SaveAsTemplatePage | null>(null)

function openSaveAs() {
  const markdown = editorRef.value?.flush() ?? body.value
  saveAsPage.value = {
    title: title.value,
    body: markdown,
    category: category.value,
    tags: tags.value.split(',').map((tag) => tag.trim()).filter(Boolean),
    relations: relationRows.value.filter((r) => r.type && r.key.trim()).map((r) => ({ type: r.type, target: r.key.trim() })),
    other: otherFrontmatter.value,
    projectId: projectId.value || null,
  }
  saveAsOpen.value = true
}

/** The template's name, for the header, once the roster knows it. */
const templateName = computed(() => (template.value ? (templates.byRef(template.value.ref)?.name ?? null) : null))
watch(
  template,
  (value) => {
    if (value) void templates.ensureLoaded()
  },
  { immediate: true },
)

/* ---------------------------------------------------------- review */

const reviewOpen = ref(false)
// The page published past a working branch is looked at once, not kept.
watch(reviewOpen, (isOpen) => {
  if (!isOpen) pastCompare.value = null
})

function openReview() {
  // The model trails typing by the editor's pause; the diff must not.
  editorRef.value?.flush()
  reviewOpen.value = true
}

/** Placement and title changes: not in the source file, so not in the diff. */
const reviewFieldChanges = computed(() => {
  const base = baseFields.value
  if (!reviewOpen.value || !base || pastCompare.value) return []
  const now = currentFields()
  const pageTitle = (id: string) =>
    id ? (store.items.find((d) => d.documentId === id)?.title ?? id) : t('documents.topLevel')
  const project = (id: string) => projects.items.find((p) => p.projectId === id)?.name ?? id
  const rows: { label: string; from: string; to: string }[] = []
  if (now.title.trim() !== base.title.trim()) rows.push({ label: t('editor.pageTitle'), from: base.title, to: now.title })
  if (now.category !== base.category) {
    rows.push({
      label: t('editor.category'),
      from: labelFor(t, 'category', base.category),
      to: labelFor(t, 'category', now.category),
    })
  }
  if (now.parentId !== base.parentId) {
    rows.push({ label: t('editor.parentPage'), from: pageTitle(base.parentId), to: pageTitle(now.parentId) })
  }
  if (isEdit.value && now.projectId !== base.projectId) {
    rows.push({ label: t('editor.project'), from: project(base.projectId), to: project(now.projectId) })
  }
  return rows
})

/**
 * The source file publishing would write, against the one it replaces — the
 * same `DiffView` a revision comparison renders, fed by the local line diff
 * the connector review uses, since neither side exists as a revision to ask
 * the compare endpoint about.
 */
const reviewCompare = computed<CompareResponse | null>(() => {
  const base = baseFields.value
  if (!reviewOpen.value || !base) return null
  if (pastCompare.value) return pastCompare.value
  const before = buildSource(base, otherFrontmatter.value)
  const after = buildSource(currentFields(), otherFrontmatter.value)
  const { hunks, additions, deletions } = lineDiff(before, after)
  const side = (revisionId: string) => ({ revisionId, revisionNumber: 0, branch: null, contentHash: null })
  return {
    documentId: editId.value ?? '',
    from: side(headRevisionId.value ?? 'new'),
    to: side('unstaged'),
    comparisonMode: 'direct',
    mergeBaseRevisionId: null,
    summary: { additions, deletions },
    hunks,
    structural: null,
    semantic: null,
  }
})

onMounted(async () => {
  if (!store.loaded) void store.fetchList()
  if (!projects.loaded) {
    void projects.fetchList().then(() => {
      if (!projectId.value) projectId.value = projects.activeId ?? ''
    })
  }
  if (editId.value) await loadPage()
})

/** Load the page being edited — again after a reset — and join its draft when the deployment co-edits. */
async function loadPage() {
  const id = editId.value
  if (!id) return
  loading.value = true
  loadError.value = null
  try {
    const path = { id }
    // Fresh: the editor writes its next revision over what it loads here.
    const [detail, defaultContent, caps, { branches }] = (await Promise.all([
      fetchApi(queryClient, '/v1/documents/{id}', { path }, { fresh: true }),
      fetchApi(queryClient, '/v1/documents/{id}/content', { path }, { fresh: true }),
      // Unknown means off: the page opens single-user, as it always has.
      fetchApi(queryClient, '/v1/collab/capabilities').catch(() => null),
      fetchApi(queryClient, '/v1/documents/{id}/branches', { path }, { fresh: true }),
    ])) as [DocumentDetailResponse, DocumentContentResponse, CollabCapabilitiesResponse | null, ListBranchesResponse]
    // An archived page is read-only until unarchived (docs/features/39);
    // the API would refuse the publish, so refuse the editing first.
    if (detail.document.archivedAt) {
      toast.info(t('verification.archived.editorBlocked'))
      await router.replace(`/documents/${id}`)
      return
    }
    const byName = (name: string | null) => branches.find((b) => b.name === name)
    if (requestedBranch && !byName(requestedBranch)) toast.error(t('editor.branchNotFound', { name: requestedBranch }))
    // A published page is edited on the caller's own working branch (#474),
    // unless a link named another. A private draft page is private already.
    const mine =
      !requestedBranch && !detail.document.draftOwnerId
        ? (await api.post('/v1/documents/{id}/branches/mine', { path })).branch
        : null
    branch.value = mine ?? byName(requestedBranch) ?? byName(detail.document.defaultBranch) ?? null
    // One working branch at a time per page and person, so it keeps the
    // page's own slot: edits stored before #474 are offered back, and the
    // page view's unstaged dot still finds them.
    branchSlot.value = branch.value && branch.value.name !== detail.document.defaultBranch && !mine ? branch.value.name : null
    const head = branch.value?.headRevisionId ?? detail.document.headRevisionId
    const content =
      head && head !== defaultContent.revisionId
        ? (await fetchApi(queryClient, '/v1/documents/{id}/content', {
            path,
            query: { revision: head },
          }))
        : defaultContent
    isDraft.value = !!detail.document.draftOwnerId
    title.value = detail.document.title
    category.value = detail.document.category
    parentId.value = detail.document.parentId ?? ''
    projectId.value = detail.document.projectId
    headRevisionId.value = head
    body.value = content.markdown
    const fm = readFrontmatter(content.frontmatter)
    otherFrontmatter.value = fm.other
    relationRows.value = fm.relations
    tags.value = fm.tags
    if (caps?.enabled && branch.value) {
      await startCollab(detail, content, branch.value, caps).catch(() => toast.info(t('editor.collab.unavailable')))
    }
  } catch (e) {
    loadError.value = e
  } finally {
    // Mounts the editor, whose `ready` captures the published baseline.
    loading.value = false
  }
}

/**
 * Provenance for `POST /v1/documents`. `provenanceOnly`, because the body goes
 * to storage afterwards: without it the server would render the template
 * itself and finalize a skeleton the author never published.
 */
function templateProvenance() {
  return template.value ? { template: { ...template.value, provenanceOnly: true } } : {}
}

/** The source file for the page as it stands — see `buildSource`. */
function pageSource(markdown: string): string {
  return buildSource({ body: markdown, relations: relationRows.value, tags: tags.value }, otherFrontmatter.value)
}

/**
 * Attachments belong to a document, so an unsaved page has nowhere to put one.
 * Rather than refusing the drop, create the page as a draft first — which is
 * what Confluence does, and what anyone pasting a screenshot into a new page
 * expects to just work.
 */
async function ensureDocumentId(): Promise<string | null> {
  if (editId.value) return editId.value
  if (!projectId.value) {
    toast.error(t('editor.pickProjectForFiles'))
    settingsOpen.value = true
    return null
  }
  try {
    // No `content`: nothing has been saved yet, and inlining the draft body here
    // sent the whole page through a JSON request just to get an id for an image.
    const res = await api.post('/v1/documents', {
      body: {
        workspaceId: getWorkspaceId(),
        projectId: projectId.value,
        title: title.value.trim() || t('editor.untitledPage'),
        category: category.value,
        ...(parentId.value ? { parentId: parentId.value } : {}),
        ...templateProvenance(),
      },
    })
    editId.value = res.documentId
    headRevisionId.value = res.revisionId
    // Claimed by the next save instead of opening a second revision.
    pendingRevisionId.value = res.revisionId
    // The edits now belong to a page: store them under its id, then free the
    // new-page slot, in that order so a crash between the two loses nothing.
    workingCopy.flush()
    removeWorkingCopy(workingCopyKey(getWorkspaceId(), null))
    void store.fetchList()
    // Keep the URL honest without unmounting the editor mid-upload. Not a
    // leave, so the leave question must not interrupt it.
    leaving = true
    try {
      await router.replace(`/documents/${res.documentId}/edit`)
    } finally {
      leaving = false
    }
    toast.success(t('editor.draftCreatedForFiles'))
    return res.documentId
  } catch (e) {
    toast.error(errorMessage(e, t))
    return null
  }
}

/**
 * Upload a revision's body straight to object storage, then finalize it.
 *
 * Both save paths go through this now. Creating a page used to inline the whole
 * markdown into the JSON POST while editing uploaded it directly — which is why
 * the same paste saved fine on an existing page and failed on a new one.
 */
async function publishRevision(
  documentId: string,
  revisionId: string,
  text: string,
): Promise<FinalizeRevisionResponse> {
  const up = await api.post('/v1/documents/{id}/uploads', {
    path: { id: documentId },
    body: { revisionId, contentType: 'text/markdown', filename: 'source.md' },
    config: { timeout: 0 },
  })
  await presignedPut(
    { url: up.upload.url, headers: { 'Content-Type': 'text/markdown' } },
    new Blob([text], { type: 'text/markdown' }),
  )
  return await api.post('/v1/documents/{id}/revisions/{revisionId}/finalize', {
    path: { id: documentId, revisionId },
    config: { timeout: 0 },
  })
}

/** The checks every write passes first: the markdown to write, or null when refused (and the author told why). */
function readyToWrite(): string | null {
  // Publishing would drop them silently — the serializer skips suggestions — so
  // they are decided first, where the author can see what they are deciding.
  if (aiPending.value.count > 0) {
    toast.error(t('editorAi.decideBeforePublish', { n: aiPending.value.count }, aiPending.value.count))
    setAiOpen(true)
    editorRef.value?.revealAi()
    return null
  }
  const markdown = editorRef.value?.flush() ?? body.value
  if (!title.value.trim() || !markdown.trim()) {
    toast.error(t('editor.titleAndContentRequired'))
    return null
  }
  if (!projectId.value) {
    toast.error(t('editor.pickProject'))
    settingsOpen.value = true
    return null
  }
  return markdown
}

/** The page's own fields — title, category, placement. Not versioned, so not on any branch. */
function patchPageFields() {
  return api.patch('/v1/documents/{id}', {
    path: { id: editId.value as string },
    body: {
      title: title.value,
      category: category.value,
      parentId: parentId.value || null,
      ...(projectId.value ? { projectId: projectId.value } : {}),
    },
  })
}

/**
 * A new revision on the branch being edited, with If-Match (plan.md §7).
 * `patchFields` sends the page fields first, as a publish onto the default
 * branch always has; a working branch keeps them for its Publish instead.
 */
async function writeRevision(markdown: string, sentMessage: string, onTop: boolean, patchFields: boolean): Promise<FinalizeRevisionResponse> {
  let text = pageSource(markdown)
  // A shared draft is published as of one snapshot (#80): finalize rebases
  // the draft onto it, and what peers typed after it stays unpublished. The
  // revision builds on the draft's base, not on the head this tab loaded:
  // a peer may have published since. "Publish on top" builds on the head
  // that moved instead, once the author has seen the difference.
  let draftFields = {}
  let ifMatch = headRevisionId.value
  if (collab.value && branch.value) {
    const { drafts } = await fetchApi(
      queryClient,
      '/v1/documents/{id}/drafts',
      { path: { id: editId.value as string } },
      { fresh: true },
    )
    const draft = drafts.find((d) => d.branchId === branch.value?.branchId)
    if (draft) {
      ifMatch = onTop && headMoved.value ? headMoved.value : draft.baseRevisionId
      draftFields = { collabDraftId: draft.draftId, draftSnapshot: collab.value.seal() }
      // Read again in the same tick as the seal: a peer's edit that landed
      // while the draft was fetched must be in the revision it is marked as.
      text = pageSource(editorRef.value?.flush() ?? markdown)
      // Sealing cleared it for everyone; this tab's field follows.
      message.value = ''
    }
  }

  if (patchFields) await patchPageFields()
  // Claim the empty draft ensureDocumentId may have left, rather than opening
  // a second revision and orphaning it.
  const claimed = pendingRevisionId.value
  pendingRevisionId.value = null
  // No branch means the default one: the server picks it.
  const revisionId =
    claimed ??
    (
      await api.post('/v1/documents/{id}/revisions', {
        path: { id: editId.value as string },
        body: {
          ...(branch.value ? { branch: branch.value.name } : {}),
          message: sentMessage || 'Edited in web editor',
          contentType: 'text/markdown',
          ...draftFields,
        },
        config: ifMatch ? { headers: { 'If-Match': ifMatch } } : undefined,
      })
    ).revisionId
  return publishRevision(editId.value as string, revisionId, text)
}

/**
 * The editor stays on a working branch after Save draft, so the baseline moves
 * to what the branch now holds. The body and its frontmatter are in the
 * revision; the page fields are not, so they stay unstaged until Publish.
 */
async function followSavedRevision(revisionId: string) {
  if (collab.value) {
    await followHead().catch(() => {})
    return
  }
  const now = currentFields()
  headRevisionId.value = revisionId
  if (baseFields.value) baseFields.value = { ...baseFields.value, body: now.body, relations: now.relations, tags: now.tags }
}

function onWriteError(e: unknown, sentMessage: string) {
  // Was a prefix match on the message text, which breaks the moment that
  // message is translated and could never distinguish a 413 from anything
  // else. Branch on the envelope instead.
  if (collab.value && !message.value) message.value = sentMessage
  if (isApiRequestError(e) && e.status === 409) {
    if (collab.value) void followHead().catch(() => {})
    if (!headMoved.value) toast.error(t('editor.headMoved'))
  } else {
    toast.error(errorMessage(e, t))
  }
}

async function save(onTop = false) {
  if (loadError.value) return
  const markdown = readyToWrite()
  if (markdown === null) return
  busy.value = true
  // Read before a shared draft's seal clears it, and put back if the publish fails.
  const sentMessage = message.value
  try {
    if (!isEdit.value) {
      const res = await api.post('/v1/documents', {
        body: {
          workspaceId: getWorkspaceId(),
          projectId: projectId.value,
          title: title.value,
          category: category.value,
          ...(parentId.value ? { parentId: parentId.value } : {}),
          ...templateProvenance(),
        },
      })
      // The body goes to storage, not through the API — see publishRevision.
      await publishRevision(res.documentId, res.revisionId, pageSource(markdown))
      workingCopy.settle()
      toast.success(t('editor.draftSaved'))
      await router.push(`/documents/${res.documentId}`)
      return
    }

    const fin = await writeRevision(markdown, sentMessage, onTop, !onWorkingBranch.value)
    if (onWorkingBranch.value) {
      await followSavedRevision(fin.revisionId)
      message.value = ''
      toast.success(fin.deduplicated ? t('editor.noContentChanges') : t('editor.draftBranch.saved'))
      return
    }
    workingCopy.settle()
    toast.success(fin.deduplicated ? t('editor.noContentChanges') : t('editor.revisionPublished'))
    await router.push(`/documents/${editId.value}`)
  } catch (e) {
    onWriteError(e, sentMessage)
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------ publishing a branch */

/**
 * The default head a Publish was refused over (#474): the page was published
 * since this branch began, and publishing now would replace that with this
 * version. Set from the 409; the author reviews, then publishes over it.
 */
const publishedPast = ref<string | null>(null)
/** The comparison the review dialog shows while `publishedPast` is being looked at. */
const pastCompare = ref<CompareResponse | null>(null)
const publishing = ref(false)

async function reviewPast() {
  if (!publishedPast.value || !headRevisionId.value) return
  try {
    pastCompare.value = await fetchApi(queryClient, '/v1/documents/{id}/compare', {
      path: { id: editId.value as string },
      query: { from: publishedPast.value, to: headRevisionId.value, mode: 'direct' },
    })
    reviewOpen.value = true
  } catch (e) {
    toast.error(errorMessage(e, t))
  }
}

/**
 * Save what is unsaved onto the branch, then publish it: merged onto the page
 * when nothing holds it, otherwise a merge request opened for review. The page
 * fields go with it, merged or held — they are not versioned, so they cannot
 * wait in review.
 */
async function publish(onTopOf?: string) {
  if (loadError.value || !editId.value || !branch.value) return
  const markdown = readyToWrite()
  if (markdown === null) return
  const id = editId.value
  const branchId = branch.value.branchId
  busy.value = true
  publishing.value = true
  const sentMessage = message.value
  try {
    if (unstaged.value) await followSavedRevision((await writeRevision(markdown, sentMessage, false, false)).revisionId)
    const res = await api.post('/v1/documents/{id}/branches/{branchId}/publish', {
      path: { id, branchId },
      body: {
        title: sentMessage.trim() || t('editor.draftBranch.mrTitle', { title: title.value }),
        ...(onTopOf ? { onTopOf } : {}),
      },
      config: { timeout: 0 },
    })
    await patchPageFields()
    publishedPast.value = null
    workingCopy.settle()
    if (res.merged) {
      toast.success(t('editor.draftBranch.published'))
      await router.push(`/documents/${id}`)
    } else {
      toast.info(t('editor.draftBranch.held.title'), { description: t(`editor.draftBranch.held.${res.reason ?? 'approvals'}`) })
      await router.push(`/merge-requests/${res.mergeRequest.mergeRequestId}`)
    }
  } catch (e) {
    const head = errorDetails(e)?.currentHeadRevisionId
    if (errorReason(e) === 'diverged' && typeof head === 'string') publishedPast.value = head
    else onWriteError(e, sentMessage)
  } finally {
    busy.value = false
    publishing.value = false
  }
}

/* ------------------------------------------------- leaving the editor */

/**
 * Whether leaving with stored edits asks first. Per browser, like the working
 * copy it guards; `useStorage` never reads localStorage during SSR, so the
 * server keeps the default and nothing leaks between requests.
 */
const confirmLeave = useStorage('kn_editor_confirm_leave', true)

const confirmOpen = ref(false)
/** Where the interrupted navigation was heading, replayed once confirmed. */
let pendingLeave: (() => Promise<unknown>) | null = null
/** Set while a confirmed leave replays its navigation, so the guard lets it by. */
let leaving = false
/**
 * The question can be skipped only where it is a courtesy: the edits are
 * stored and the exit is not Cancel. Set per prompt, not derived, so the
 * checkbox does not appear mid-dialog if a write starts failing.
 */
const leaveOptional = ref(false)
/** The dialog's "don't ask again", committed only by leaving — not by staying. */
const stopAsking = ref(false)

function destination(): string {
  return editId.value ? `/documents/${editId.value}` : '/documents'
}

/**
 * Cancel is the one exit that asks even when the edits are safe: it reads as
 * "throw this away", and they are kept unless the author says so.
 */
function cancel() {
  if (!unstaged.value || collab.value) {
    void router.push(destination())
    return
  }
  workingCopy.flush()
  pendingLeave = () => router.push(destination())
  leaveOptional.value = false
  confirmOpen.value = true
}

function leave() {
  confirmOpen.value = false
  if (leaveOptional.value && stopAsking.value) confirmLeave.value = false
  const go = pendingLeave
  pendingLeave = null
  if (!go) return
  // Cleared once the replay settles: a navigation another guard refuses must
  // not leave this one waving every later exit through.
  leaving = true
  void go().finally(() => {
    leaving = false
  })
}

function discardAndLeave() {
  workingCopy.settle()
  leave()
}

function keepAndLeave() {
  if (workingCopy.flush()) leave()
}

// Any other in-app navigation asks too, even though the edits are already
// stored and restored on return: leaving a page mid-edit is worth a beat
// before it happens. The dialog's "don't ask again" turns that off
// (`kn_editor_confirm_leave`); a refused write asks regardless, since there
// leaving really would lose the edits.
onBeforeRouteLeave((to) => {
  // A shared draft is already kept, on the server and on this device.
  if (leaving || collab.value || !unstaged.value || busy.value) return true
  const stored = workingCopy.flush()
  if (stored && !confirmLeave.value) return true
  pendingLeave = () => router.push(to.fullPath)
  leaveOptional.value = stored
  stopAsking.value = false
  confirmOpen.value = true
  return false
})

// Closing the tab or reloading: write the copy, then the browser's own prompt
// — a custom one cannot be shown there — under the same rule as above.
function beforeUnload(event: BeforeUnloadEvent) {
  if (collab.value || !unstaged.value) return
  if (workingCopy.flush() && !confirmLeave.value) return
  event.preventDefault()
  event.returnValue = ''
}
if (!import.meta.env.SSR) window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => {
  if (!import.meta.env.SSR) window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <div class="kn-page-editor" :data-ai-open="aiOpen ? 'true' : 'false'">
    <div class="kn-page-column">
      <!-- The page's visible title is a field, not a heading, so the route's
           one h1 is spoken only. -->
      <h1 class="sr-only">
        {{ title.trim() || (isEdit ? t('editor.editing') : t('editor.newPage')) }}
      </h1>
      <!-- The action bar (#441), in the shell's strip under the breadcrumbs —
           the same place the page view's bar stands, so Edit and Publish do not
           jump between reading and writing. The trail above names the project
           and the page; the bar names only the state of this edit. -->
      <Teleport to="#kn-page-toolbar">
        <div class="kn-bar-start kn-page-crumb">
          <span class="kn-page-state">{{ isEdit ? t('editor.editing') : t('editor.newPage') }}</span>
          <!-- Whose eyes this edit is under (#474): private until shared or
               published, readable by the page's readers once in review. -->
          <span
            v-if="onWorkingBranch"
            class="kn-page-state inline-flex items-center gap-1"
            :title="branch?.restricted ? t('editor.draftBranch.privateHint') : t('editor.draftBranch.inReviewHint')"
          >
            <NotepadTextDashed class="size-3.5" aria-hidden="true" />
            {{ branch?.restricted ? t('editor.draftBranch.private') : t('editor.draftBranch.inReview') }}
          </span>
          <span v-if="!isEdit && template" class="kn-page-state">
            {{ templateName ? t('editor.fromTemplate', { name: templateName }) : t('editor.fromATemplate') }}
          </span>
          <CollabStatus v-if="collab" :status="collab.status" />
          <!-- The working copy's state (or the shared draft's), and the way into what it holds. -->
          <button
            v-if="unstaged"
            type="button"
            class="kn-unstaged-chip"
            :data-failed="workingCopy.persistFailed.value ? 'true' : undefined"
            :title="
              collab
                ? t('editor.collab.unpublished.hint')
                : workingCopy.persistFailed.value
                ? t('editor.unstaged.notSaved')
                : workingCopy.savedAt.value
                  ? t('editor.unstaged.savedLocally', { when: formatDateTime(new Date(workingCopy.savedAt.value)) })
                  : t('editor.unstaged.label')
            "
            @click="openReview"
          >
            <span class="kn-dirty-dot" aria-hidden="true" />
            <span class="kn-unstaged-label">
              {{ collab ? t('editor.collab.unpublished.label') : t('editor.unstaged.label') }}
            </span>
          </button>
        </div>

        <div class="kn-bar-end">
          <CollabPresence v-if="collab" :peers="collab.status.peers" :writers="editorRef?.aiWriters ?? []" />
          <Button
            variant="ghost"
            size="sm"
            v-feature="'assistant'"
            class="kn-ai-toggle"
            :aria-pressed="aiOpen"
            :title="`${t('editorAi.toggle')} (${modKey}J)`"
            @click="setAiOpen(!aiOpen)"
          >
            <Sparkles class="size-4" /> <span class="kn-bar-label">{{ t('editorAi.button') }}</span>
          </Button>
          <!-- Labels while the bar has room, icons when it does not; Publish
               keeps its word at every width — it is the one irreversible act here. -->
          <Button variant="ghost" size="sm" :title="t('editor.settings')" @click="settingsOpen = true">
            <Settings2 class="size-4" /> <span class="kn-bar-label">{{ t('editor.settings') }}</span>
          </Button>
          <Button variant="ghost" size="sm" :title="t('common.cancel')" @click="cancel">
            <X class="size-4" /> <span class="kn-bar-label">{{ t('common.cancel') }}</span>
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="t('editor.moreActions')">
                <MoreHorizontal class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <!-- What this edit holds that the page does not, and the two
                   things to do about it — the same review the chip opens. -->
              <DropdownMenuSub v-if="unstaged">
                <DropdownMenuSubTrigger>
                  <GitCompareArrows class="size-4" /> {{ t('editor.menu.changes') }}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="w-52">
                  <DropdownMenuItem @select="openReview">
                    <Eye class="size-4" /> {{ t('editor.menu.review') }}
                  </DropdownMenuItem>
                  <!-- Asks first either way: from a menu there is no diff on
                       screen showing what would go. -->
                  <DropdownMenuItem
                    variant="destructive"
                    :disabled="collab !== null && !collab.status.writable"
                    @select="discardOpen = true"
                  >
                    <Undo2 class="size-4" />
                    {{ collab ? t('editor.collab.discard.action') : t('editor.unstaged.discardAll') }}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <LayoutTemplate class="size-4" /> {{ t('editor.menu.template') }}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent class="w-52">
                  <!-- The `/template` slash command's gallery, inserting at the cursor. -->
                  <DropdownMenuItem
                    :disabled="!editorRef || (collab !== null && !collab.status.writable)"
                    @select="editorRef?.openTemplates()"
                  >
                    <FilePlus2 class="size-4" /> {{ t('editor.menu.insertTemplate') }}
                  </DropdownMenuItem>
                  <DropdownMenuItem @select="openSaveAs">
                    <Save class="size-4" /> {{ t('templates.saveAs.action') }}
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <!-- A working branch (#474): saving keeps it private, publishing is
               the act that reaches readers, so it keeps the primary weight. -->
          <Button
            v-if="canShareBranch"
            variant="ghost"
            size="sm"
            :title="t('editor.draftBranch.shareHint')"
            @click="shareOpen = true"
          >
            <UserPlus class="size-4" /> <span class="kn-bar-label">{{ t('editor.draftBranch.share') }}</span>
          </Button>
          <Button
            v-if="onWorkingBranch"
            size="sm"
            variant="outline"
            :disabled="busy || loading || loadError !== null || (collab !== null && !collab.status.writable)"
            @click="save()"
          >
            {{ busy && !publishing ? t('common.saving') : t('editor.saveDraft') }}
          </Button>
          <Button
            size="sm"
            :disabled="busy || loading || loadError !== null || (collab !== null && !collab.status.writable)"
            @click="onWorkingBranch ? publish() : save()"
          >
            {{
              onWorkingBranch
                ? publishing
                  ? t('editor.draftBranch.publishing')
                  : t('editor.publish')
                : busy
                  ? t('common.saving')
                  : isDraft
                    ? t('editor.saveDraft')
                    : t('editor.publish')
            }}
          </Button>
        </div>
      </Teleport>

      <div class="kn-page-body">
        <div class="kn-page-main">
          <div v-if="loading" class="space-y-3 p-8">
            <Skeleton class="h-10 w-2/3" />
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-5/6" />
            <Skeleton class="h-64 w-full" />
          </div>

          <div v-else-if="loadError" class="p-8">
            <PageState
              state="error"
              :title="t('editor.loadFailed.title')"
              :description="t('editor.loadFailed.body', { reason: errorMessage(loadError, t) })"
            >
              <template #actions>
                <div class="flex flex-wrap justify-center gap-2">
                  <Button size="sm" variant="outline" @click="loadPage()">{{ t('common.retry') }}</Button>
                  <Button size="sm" variant="ghost" as-child>
                    <RouterLink :to="`/documents/${editId}`">{{ t('editor.loadFailed.openPage') }}</RouterLink>
                  </Button>
                </div>
              </template>
            </PageState>
          </div>

          <template v-else>
            <div v-if="staleCopy" class="kn-stale-copy" role="status">
              <History class="size-4 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">
                  {{ t('editor.unstaged.staleTitle', { when: formatDateTime(new Date(staleCopy.savedAt)) }) }}
                </p>
                <p class="text-muted-foreground">
                  {{ isEdit ? t('editor.unstaged.staleBody') : t('editor.unstaged.otherNewPage') }}
                </p>
              </div>
              <Button size="sm" variant="ghost" @click="discardStale">{{ t('editor.unstaged.discard') }}</Button>
              <Button size="sm" variant="outline" @click="restoreStale">{{ t('editor.unstaged.restore') }}</Button>
            </div>

            <div v-if="localCopy" class="kn-stale-copy" role="status">
              <History class="size-4 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">
                  {{ t('editor.collab.localCopy.title', { when: formatDateTime(new Date(localCopy.savedAt)) }) }}
                </p>
                <p class="text-muted-foreground">{{ t('editor.collab.localCopy.body') }}</p>
              </div>
              <Button size="sm" variant="ghost" @click="discardLocalCopy">{{ t('editor.collab.localCopy.ignore') }}</Button>
              <Button
                size="sm"
                variant="outline"
                :disabled="!collab?.status.writable"
                @click="applyLocalCopy"
              >
                {{ t('editor.collab.localCopy.apply') }}
              </Button>
            </div>

            <!-- Published past the draft by another path: say so before a publish would undo it. -->
            <div v-if="headMoved" class="kn-stale-copy" role="status">
              <GitCompareArrows class="size-4 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">{{ t('editor.collab.headMoved.title') }}</p>
                <p class="text-muted-foreground">{{ t('editor.collab.headMoved.body') }}</p>
              </div>
              <Button size="sm" variant="ghost" :disabled="!collab?.status.writable" @click="discardOpen = true">
                {{ t('editor.collab.discard.action') }}
              </Button>
              <Button size="sm" variant="ghost" @click="openReview">{{ t('editor.collab.headMoved.review') }}</Button>
              <Button size="sm" variant="outline" :disabled="busy || !collab?.status.writable" @click="save(true)">
                {{ t('editor.collab.headMoved.publishOnTop') }}
              </Button>
            </div>

            <!-- Published since this branch began (#474): publishing now replaces
                 that version with this one, so it is looked at first. -->
            <div v-if="publishedPast" class="kn-stale-copy" role="status">
              <GitCompareArrows class="size-4 shrink-0" aria-hidden="true" />
              <div class="min-w-0 flex-1">
                <p class="font-medium">{{ t('editor.draftBranch.past.title') }}</p>
                <p class="text-muted-foreground">{{ t('editor.draftBranch.past.body') }}</p>
              </div>
              <Button size="sm" variant="ghost" @click="reviewPast">{{ t('editor.draftBranch.past.review') }}</Button>
              <Button size="sm" variant="outline" :disabled="busy" @click="publish(publishedPast ?? undefined)">
                {{ t('editor.draftBranch.past.publishOver') }}
              </Button>
            </div>

            <RichEditor
              ref="editorRef"
              v-model="body"
              :collab="collab ?? undefined"
              :editable="!collab || collab.status.writable"
              :pages="mentionablePages"
              :resolve-document-id="ensureDocumentId"
              :template-context="templateContext"
              @ready="onEditorReady"
              @apply-template-defaults="applyInsertedTemplate"
            >
              <template #lede>
                <textarea
                  v-model="title"
                  class="kn-title-input"
                  rows="1"
                  :placeholder="t('editor.pageTitle')"
                  :aria-label="t('editor.pageTitle')"
                  :readonly="collab !== null && !collab.status.writable"
                  spellcheck="false"
                  @keydown.enter.prevent="editorRef?.focus()"
                />
              </template>
            </RichEditor>
          </template>
        </div>
      </div>
    </div>

    <!-- The assistant opens on the right edge, after the page in reading and
         tab order. The slot's width snaps (a width transition re-lays out the
         whole ProseMirror document every frame); the panel inside it slides
         in with a transform, and on close the width holds until it is out. -->
    <div class="kn-ai-slot" :inert="!aiOpen || undefined">
      <EditorAiPanel
        v-if="aiMounted"
        ref="aiPanel"
        :document-id="editId"
        :pending="aiPending"
        :blank="!body.trim()"
        :mod="modKey"
        @close="setAiOpen(false)"
        @accept="editorRef?.acceptAi()"
        @discard="editorRef?.discardAi()"
        @reveal="editorRef?.revealAi()"
      />
    </div>
    <!-- Below lg the panel floats over the page; this is how you get back. -->
    <div class="kn-ai-scrim" aria-hidden="true" @click="setAiOpen(false)" />

    <!-- Leaving with unstaged edits. Normally they are kept and this asks only
         whether to keep them; when the browser refused to store them, keeping is
         not on offer and this is the old discard question. -->
    <!-- Three actions, and Russian runs them long: the dialog is wider than
         the default, the row wraps rather than overflowing, and staying is
         set apart on the left from the two ways of leaving. -->
    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent class="sm:max-w-2xl">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {{ workingCopy.persistFailed.value ? t('editor.discardChanges') : t('editor.unstaged.leaveTitle') }}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {{ workingCopy.persistFailed.value ? t('editor.discardBody') : t('editor.unstaged.leaveBody') }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <!-- Only on a navigation that would keep the edits: Cancel and a refused
             write are questions about losing them, and those always ask. -->
        <label v-if="leaveOptional" class="flex items-center gap-2 text-sm text-muted-foreground">
          <Checkbox v-model="stopAsking" />
          {{ t('editor.unstaged.dontAskAgain') }}
        </label>
        <AlertDialogFooter class="sm:flex-wrap">
          <AlertDialogCancel class="sm:mr-auto" @click="pendingLeave = null">{{ t('editor.keepEditing') }}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            @click="discardAndLeave"
          >
            {{ t('editor.discardChangesAction') }}
          </AlertDialogAction>
          <AlertDialogAction v-if="!workingCopy.persistFailed.value" @click="keepAndLeave">
            {{ t('editor.unstaged.keepAndLeave') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- What publishing would change, before it does. The shared draft's
         question, or — from the ⋯ menu's Changes ▸ (#441) — this browser's
         working copy's. -->
    <AlertDialog v-model:open="discardOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ collab ? t('editor.collab.discard.title') : t('editor.discardChanges') }}</AlertDialogTitle>
          <AlertDialogDescription>
            {{
              !collab
                ? t('editor.menu.discardBody')
                : collab.status.peers.length > 0
                  ? t('editor.collab.discard.bodyPeers', { n: collab.status.peers.length }, collab.status.peers.length)
                  : t('editor.collab.discard.body')
            }}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('editor.keepEditing') }}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" @click="collab ? discardDraft() : discardUnstaged()">
            {{ collab ? t('editor.collab.discard.confirm') : t('editor.discardChangesAction') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <Dialog v-model:open="reviewOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <!-- Named like the chip that opened it: a shared draft is unpublished, not unstaged in this browser. -->
          <DialogTitle>
            {{
              t(pastCompare ? 'editor.draftBranch.past.reviewTitle' : collab ? 'editor.collab.unpublished.label' : 'editor.unstaged.reviewTitle')
            }}
          </DialogTitle>
          <DialogDescription>
            {{ t(pastCompare ? 'editor.draftBranch.past.reviewDesc' : 'editor.unstaged.reviewDesc') }}
          </DialogDescription>
        </DialogHeader>

        <dl v-if="reviewFieldChanges.length" class="kn-unstaged-fields">
          <template v-for="row in reviewFieldChanges" :key="row.label">
            <dt>{{ row.label }}</dt>
            <dd>
              <del>{{ row.from || '—' }}</del>
              <span aria-hidden="true">→</span>
              <ins>{{ row.to || '—' }}</ins>
            </dd>
          </template>
        </dl>

        <DiffView v-if="reviewCompare && reviewCompare.hunks.length" :compare="reviewCompare" />
        <p v-else class="text-sm text-muted-foreground">{{ t('editor.unstaged.noSourceChanges') }}</p>

        <DialogFooter>
          <Button
            v-if="pastCompare"
            variant="outline"
            :disabled="busy || !publishedPast"
            @click="(reviewOpen = false, publish(publishedPast ?? undefined))"
          >
            {{ t('editor.draftBranch.past.publishOver') }}
          </Button>
          <Button v-else-if="!collab" variant="ghost" class="text-destructive" @click="discardUnstaged">
            {{ t('editor.unstaged.discardAll') }}
          </Button>
          <!-- A shared draft is everyone's: discarding it resets it for every peer, so it asks first. -->
          <Button
            v-else
            variant="ghost"
            class="text-destructive"
            :disabled="!collab.status.writable"
            @click="askDiscard"
          >
            {{ t('editor.collab.discard.action') }}
          </Button>
          <Button @click="reviewOpen = false">{{ t('editor.keepEditing') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- Who this working branch is shared with (#474): view or edit. -->
    <PageAccessDialog
      v-if="canShareBranch && branch && editId"
      v-model:open="shareOpen"
      resource-type="document"
      :resource-id="editId"
      :title="title"
      :branch-id="branch.branchId"
    />

    <!-- Page settings: everything that is metadata rather than the page. -->
    <Sheet v-model:open="settingsOpen">
      <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{{ t('editor.pageSettings') }}</SheetTitle>
          <SheetDescription>
            {{ t('editor.settingsDesc') }}
          </SheetDescription>
        </SheetHeader>

        <!-- One switch for every field: a read-only peer's writes would be dropped by the server anyway. -->
        <fieldset class="min-w-0 space-y-5 px-4 pb-8" :disabled="collab !== null && !collab.status.writable">
          <Autocomplete
            v-model="projectSelection"
            :label="t('editor.project')"
            :placeholder="t('editor.searchProjects')"
            :options="projectOptions"
            :multiple="false"
            :empty-hint="t('hints.noProjects')"
          />

          <Autocomplete
            v-model="parentSelection"
            :label="t('editor.parentPage')"
            :placeholder="t('editor.searchPages')"
            :options="parentOptions"
            :multiple="false"
          />

          <Autocomplete
            v-model="categorySelection"
            :label="t('editor.category')"
            :placeholder="t('editor.searchCategories')"
            :options="categoryOptions"
            :multiple="false"
          />

          <div v-if="isEdit" class="space-y-1.5">
            <Label for="editor-message" class="kn-field-label">{{ t('editor.revisionMessage') }}</Label>
            <Input id="editor-message" v-model="message" :placeholder="t('editor.revisionMessagePlaceholder')" class="h-8 text-xs" />
          </div>

          <div class="space-y-2 border-t pt-5">
            <div class="space-y-1">
              <h3 class="kn-field-label">{{ t('editor.relations') }}</h3>
              <p class="text-xs leading-snug text-muted-foreground">
                {{ t('editor.relationsHint') }}
              </p>
            </div>
            <div v-for="(row, i) in relationRows" :key="i" class="grid grid-cols-[1fr_auto] gap-2">
              <div class="space-y-2">
                <Autocomplete
                  :model-value="[row.type]"
                  :label="t('editor.relationTypeLabel', { n: i + 1 })"
                  hide-label
                  :placeholder="t('editor.relationTypePlaceholder')"
                  :options="relationTypeOptions"
                  :multiple="false"
                  @update:model-value="row.type = $event[0] ?? row.type"
                />
                <Input v-model="row.key" placeholder="service:identity" class="h-8 font-mono text-xs" />
                <ApiOperationRef v-if="isOperationKey(row.key)" :workspace-id="getWorkspaceId()" :entity-key="row.key.trim()" />
                <Input v-model="row.name" :placeholder="t('editor.relationDisplayName')" class="h-8 text-xs" />
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                :aria-label="t('editor.removeRelation', { n: i + 1 })"
                @click="relationRows.splice(i, 1)"
              >
                <X class="size-4" />
              </Button>
            </div>
            <div class="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                @click="relationRows.push({ type: 'DEPENDS_ON', key: '', name: '' })"
              >
                {{ t('editor.addRelation') }}
              </Button>
              <ApiOperationPicker :workspace-id="getWorkspaceId()" align="end" @pick="linkOperation">
                <template #trigger="{ toggle }">
                  <Button size="sm" variant="ghost" @click="toggle">
                    <Route class="size-3.5" />
                    {{ t('apiLink.relation') }}
                  </Button>
                </template>
              </ApiOperationPicker>
            </div>
          </div>

          <div class="space-y-1.5">
            <Label for="editor-tags" class="kn-field-label">{{ t('editor.tags') }}</Label>
            <Input id="editor-tags" v-model="tags" :placeholder="t('editor.tagsPlaceholder')" class="h-8 text-xs" />
          </div>
        </fieldset>
      </SheetContent>
    </Sheet>

    <SaveAsTemplateDialog v-model:open="saveAsOpen" :page="saveAsPage" />
  </div>
</template>
