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
// A new page can start from a template (issue #69): `/create?template=` opens
// on the skeleton the gallery rendered, and the template is sent as provenance
// when the page is created. `/template` inserts one at the cursor of any page,
// and "Save as template" goes the other way.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { onKeyStroke, useStorage } from '@vueuse/core'
import { History, LayoutTemplate, MoreHorizontal, Route, Settings2, Sparkles, X } from 'lucide-vue-next'
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  collabDocName,
  type CollabCapabilitiesResponse,
  type CompareResponse,
  type CreateDocumentResponse,
  type CreateUploadResponse,
  type DocumentCategory,
  type DocumentContentResponse,
  type DocumentDetailResponse,
  type FinalizeRevisionResponse,
  type ListBranchesResponse,
  type RenderTemplateResponse,
  type RevisionInfo,
} from '@knowledge/contracts'
import { SCHEMA_VERSION, editorSchema, parseMarkdown } from '@knowledge/editor-schema'
import { ApiError, apiFetch, getWorkspaceId } from '@/lib/api'
import { errorMessage } from '@/api/errors'
import { presignedPut } from '@/lib/presigned-put'
import { labelFor } from '@/lib/labels'
import { formatDateTime } from '@/lib/format'
import { lineDiff } from '@/lib/line-diff'
import {
  buildSource,
  mergeTemplateDefaults,
  readFrontmatter,
  samePage,
  type PageFields,
  type RelationRow,
  type TemplateProvenance,
} from '@/lib/page-source'
import {
  readWorkingCopy,
  removeWorkingCopy,
  workingCopyKey,
  type WorkingCopy,
} from '@/lib/working-copy'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useTemplatesStore } from '@/stores/templates'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Autocomplete, type AutocompleteOption } from '@/components/ui/autocomplete'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import RichEditor from '@/components/editor/RichEditor.vue'
import ApiOperationPicker, { type PickedOperation } from '@/components/api-reference/ApiOperationPicker.vue'
import ApiOperationRef from '@/components/api-reference/ApiOperationRef.vue'
import SaveAsTemplateDialog, { type SaveAsTemplatePage } from '@/components/templates/SaveAsTemplateDialog.vue'
import { useWorkingCopy } from '@/components/editor/use-working-copy'
import { docToMarkdown } from '@/components/editor/editor-streams'
import type { CollabHandle } from '@/components/editor/use-collab'
import CollabStatus from '@/components/editor/CollabStatus.vue'
import CollabPresence from '@/components/editor/CollabPresence.vue'
import DiffView from '@/components/knowledge/DiffView.vue'
import EditorAiPanel from '@/components/editor/EditorAiPanel.vue'
import { connectDraft } from '@/stores/assistant'
import { useSidebarStore } from '@/stores/sidebar'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()
const store = useDocumentsStore()
const projects = useProjectsStore()
const templates = useTemplatesStore()

const editId = ref<string | null>((route.params.id as string | undefined) ?? null)
const isEdit = computed(() => editId.value !== null)

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
const settingsOpen = ref(false)
const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)

/* ------------------------------------------------------- assistant */

const sidebar = useSidebarStore()
/** Cookie-backed, so the server paints the panel where the author left it. */
const aiOpen = computed(() => sidebar.aiPanelOpen)
/**
 * Mounted on first open and kept after: closing keeps the conversation and its
 * scroll where they were, and a page whose panel was never opened never loads
 * the chat roster.
 */
const aiMounted = ref(aiOpen.value)
const aiPanel = ref<InstanceType<typeof EditorAiPanel> | null>(null)

function setAiOpen(open: boolean) {
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

const projectName = computed(
  () => projects.items.find((p) => p.projectId === projectId.value)?.name ?? t('import.project'),
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

const storageKey = computed(() => workingCopyKey(getWorkspaceId(), editId.value))

/* ------------------------------------------------------ shared draft */

/** The page's shared draft, once joined (#80). `null` edits alone, exactly as before. */
const collab = shallowRef<CollabHandle | null>(null)
let unbindFields: (() => void) | null = null
/** A working copy from before this page was edited live, offered once, applied only on a click. */
const localCopy = ref<WorkingCopy | null>(null)

/** How long joining may hold the skeleton before the page opens single-user instead. */
const COLLAB_JOIN_TIMEOUT_MS = 10_000

/**
 * Join the default branch's shared draft and hold the editor until it is here
 * to show. Anything short of that — no branch, a refusal, a socket that never
 * opens — leaves the page as it always was: single-user, working copy and all.
 */
async function startCollab(detail: DocumentDetailResponse, caps: CollabCapabilitiesResponse) {
  const doc = detail.document
  const { branches } = await apiFetch<ListBranchesResponse>(`/v1/documents/${doc.documentId}/branches`)
  const branch = branches.find((b) => b.name === doc.defaultBranch)
  if (!branch) return
  // Loaded only here: a deployment that does not co-edit never fetches Yjs.
  const { createCollab, bindPageFields, META_FIELD } = await import('@/components/editor/use-collab')
  const handle = createCollab({
    name: collabDocName(doc.workspaceId, doc.documentId, branch.branchId),
    schemaMatches: caps.schemaVersion === SCHEMA_VERSION,
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
  // The published page as the editor would write it: what "unpublished" is
  // measured against. The editor itself only ever holds the draft.
  baseFields.value = {
    ...currentFields(),
    body: docToMarkdown(parseMarkdown(body.value, document), editorSchema),
    message: '',
  }
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
  // per-browser one restored into it would be a second seed.
  key: () => (collab.value ? null : storageKey.value),
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
      rendered = await apiFetch<RenderTemplateResponse>('/v1/templates/render', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: getWorkspaceId(),
          ref,
          ...(title.value.trim() ? { title: title.value.trim() } : {}),
          ...(projectId.value ? { projectId: projectId.value } : {}),
          ...(parentId.value ? { parentId: parentId.value } : {}),
        }),
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

function openReview() {
  // The model trails typing by the editor's pause; the diff must not.
  editorRef.value?.flush()
  reviewOpen.value = true
}

/** Placement and title changes: not in the source file, so not in the diff. */
const reviewFieldChanges = computed(() => {
  const base = baseFields.value
  if (!reviewOpen.value || !base) return []
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
  if (!editId.value) return
  loading.value = true
  try {
    const [detail, content, caps] = await Promise.all([
      apiFetch<DocumentDetailResponse>(`/v1/documents/${editId.value}`),
      apiFetch<DocumentContentResponse>(`/v1/documents/${editId.value}/content`),
      // Unknown means off: the page opens single-user, as it always has.
      apiFetch<CollabCapabilitiesResponse>('/v1/collab/capabilities').catch(() => null),
    ])
    // An archived page is read-only until unarchived (docs/features/39);
    // the API would refuse the publish, so refuse the editing first.
    if (detail.document.archivedAt) {
      toast.info(t('verification.archived.editorBlocked'))
      await router.replace(`/documents/${editId.value}`)
      return
    }
    title.value = detail.document.title
    category.value = detail.document.category
    parentId.value = detail.document.parentId ?? ''
    projectId.value = detail.document.projectId
    headRevisionId.value = detail.document.headRevisionId
    body.value = content.markdown
    const fm = readFrontmatter(content.frontmatter)
    otherFrontmatter.value = fm.other
    relationRows.value = fm.relations
    tags.value = fm.tags
    if (caps?.enabled) await startCollab(detail, caps).catch(() => toast.info(t('editor.collab.unavailable')))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    // Mounts the editor, whose `ready` captures the published baseline.
    loading.value = false
  }
})

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
    const res = await apiFetch<CreateDocumentResponse>('/v1/documents', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        projectId: projectId.value,
        title: title.value.trim() || t('editor.untitledPage'),
        category: category.value,
        ...(parentId.value ? { parentId: parentId.value } : {}),
        ...templateProvenance(),
      }),
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
  const up = await apiFetch<CreateUploadResponse>(`/v1/documents/${documentId}/uploads`, {
    method: 'POST',
    body: JSON.stringify({ revisionId, contentType: 'text/markdown', filename: 'source.md' }),
  })
  await presignedPut(
    { url: up.upload.url, headers: { 'Content-Type': 'text/markdown' } },
    new Blob([text], { type: 'text/markdown' }),
  )
  return apiFetch<FinalizeRevisionResponse>(
    `/v1/documents/${documentId}/revisions/${revisionId}/finalize`,
    { method: 'POST' },
  )
}

async function save() {
  // Publishing would drop them silently — the serializer skips suggestions — so
  // they are decided first, where the author can see what they are deciding.
  if (aiPending.value.count > 0) {
    toast.error(t('editorAi.decideBeforePublish', { n: aiPending.value.count }, aiPending.value.count))
    setAiOpen(true)
    editorRef.value?.revealAi()
    return
  }
  const markdown = editorRef.value?.flush() ?? body.value
  if (!title.value.trim() || !markdown.trim()) {
    toast.error(t('editor.titleAndContentRequired'))
    return
  }
  if (!projectId.value) {
    toast.error(t('editor.pickProject'))
    settingsOpen.value = true
    return
  }
  busy.value = true
  try {
    const text = pageSource(markdown)
    if (!isEdit.value) {
      const res = await apiFetch<CreateDocumentResponse>('/v1/documents', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: getWorkspaceId(),
          projectId: projectId.value,
          title: title.value,
          category: category.value,
          ...(parentId.value ? { parentId: parentId.value } : {}),
          ...templateProvenance(),
        }),
      })
      // The body goes to storage, not through the API — see publishRevision.
      await publishRevision(res.documentId, res.revisionId, text)
      workingCopy.settle()
      toast.success(t('editor.documentCreated'))
      await router.push(`/documents/${res.documentId}`)
      return
    }

    // Edit: metadata via PATCH, then a new revision with If-Match (plan.md §7).
    await apiFetch(`/v1/documents/${editId.value}`, {
      method: 'PATCH',
      body: JSON.stringify({
        title: title.value,
        category: category.value,
        parentId: parentId.value || null,
        ...(projectId.value ? { projectId: projectId.value } : {}),
      }),
    })
    // Claim the empty draft ensureDocumentId may have left, rather than opening
    // a second revision and orphaning it.
    const claimed = pendingRevisionId.value
    pendingRevisionId.value = null
    const revisionId =
      claimed ??
      (
        await apiFetch<RevisionInfo>(`/v1/documents/${editId.value}/revisions`, {
          method: 'POST',
          headers: headRevisionId.value ? { 'If-Match': headRevisionId.value } : {},
          body: JSON.stringify({
            message: message.value || 'Edited in web editor',
            contentType: 'text/markdown',
          }),
        })
      ).revisionId
    const fin = await publishRevision(editId.value as string, revisionId, text)
    workingCopy.settle()
    toast.success(fin.deduplicated ? t('editor.noContentChanges') : t('editor.revisionPublished'))
    await router.push(`/documents/${editId.value}`)
  } catch (e) {
    // Was a prefix match on the message text, which breaks the moment that
    // message is translated and could never distinguish a 413 from anything
    // else. Branch on the envelope instead.
    if (e instanceof ApiError && e.status === 409) {
      toast.error(t('editor.headMoved'))
    } else {
      toast.error(errorMessage(e, t))
    }
  } finally {
    busy.value = false
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
      <header class="kn-page-head">
        <div class="kn-page-crumb">
          <strong>{{ projectName }}</strong>
          <span class="kn-page-state">{{ isEdit ? t('editor.editing') : t('editor.newPage') }}</span>
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

        <div class="ml-auto flex items-center gap-1.5">
          <CollabPresence v-if="collab" :peers="collab.status.peers" />
          <Button
            variant="ghost"
            size="sm"
            class="kn-ai-toggle"
            :aria-pressed="aiOpen"
            :title="`${t('editorAi.toggle')} (${modKey}J)`"
            @click="setAiOpen(!aiOpen)"
          >
            <Sparkles class="size-4" /> <span class="hidden sm:inline">{{ t('editorAi.button') }}</span>
          </Button>
          <Button variant="ghost" size="sm" class="hidden sm:inline-flex" @click="settingsOpen = true">
            <Settings2 class="size-4" /> {{ t('editor.settings') }}
          </Button>
          <Button variant="ghost" size="sm" class="hidden sm:inline-flex" @click="cancel">{{ t('common.cancel') }}</Button>
          <!-- Below sm the row holds the assistant, this, and Publish: the two
               controls you reach for least fold into one menu. -->
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <Button variant="ghost" size="icon-sm" :aria-label="t('editor.moreActions')">
                <MoreHorizontal class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-48">
              <DropdownMenuItem class="sm:hidden" @select="settingsOpen = true">
                <Settings2 class="size-4" /> {{ t('editor.settings') }}
              </DropdownMenuItem>
              <DropdownMenuItem class="sm:hidden" @select="cancel">
                <X class="size-4" /> {{ t('common.cancel') }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="openSaveAs">
                <LayoutTemplate class="size-4" /> {{ t('templates.saveAs.action') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" :disabled="busy || loading || (collab !== null && !collab.status.writable)" @click="save">
            {{ busy ? t('common.saving') : isEdit ? t('editor.publish') : t('editor.createAndIndex') }}
          </Button>
        </div>
      </header>

      <div class="kn-page-body">
        <div class="kn-page-main">
          <div v-if="loading" class="space-y-3 p-8">
            <Skeleton class="h-10 w-2/3" />
            <Skeleton class="h-4 w-full" />
            <Skeleton class="h-4 w-5/6" />
            <Skeleton class="h-64 w-full" />
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
         tab order. The slot's width is what animates, on the rail's curve, so
         the page column narrows in the same motion as the panel arrives. -->
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
            class="bg-destructive text-white hover:bg-destructive/90"
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

    <!-- What publishing would change, before it does. -->
    <Dialog v-model:open="reviewOpen">
      <DialogContent class="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{{ t('editor.unstaged.reviewTitle') }}</DialogTitle>
          <DialogDescription>{{ t('editor.unstaged.reviewDesc') }}</DialogDescription>
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
          <!-- A shared draft is everyone's: throwing it away is phase 4's reset, not this. -->
          <Button v-if="!collab" variant="ghost" class="text-destructive" @click="discardUnstaged">
            {{ t('editor.unstaged.discardAll') }}
          </Button>
          <Button @click="reviewOpen = false">{{ t('editor.keepEditing') }}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

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
