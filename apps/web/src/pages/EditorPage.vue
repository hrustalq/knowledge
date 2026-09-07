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
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import { Settings2, Sparkles, X } from 'lucide-vue-next'
import {
  DOCUMENT_CATEGORIES,
  type CreateDocumentResponse,
  type CreateUploadResponse,
  type DocumentCategory,
  type DocumentContentResponse,
  type DocumentDetailResponse,
  type FinalizeRevisionResponse,
  type RevisionInfo,
} from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import RichEditor from '@/components/editor/RichEditor.vue'
import ChatPane from '@/components/assistant/ChatPane.vue'

const RELATION_TYPES = ['DESCRIBES', 'DEPENDS_ON', 'IMPLEMENTS', 'RELATED_TO', 'OWNED_BY', 'SUPERSEDES', 'CONTRADICTS'] as const

interface RelationRow {
  type: string
  key: string
  name: string
}

const route = useRoute()
const router = useRouter()
const store = useDocumentsStore()
const projects = useProjectsStore()

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
const headRevisionId = ref<string | null>(null)
const busy = ref(false)
const loading = ref(false)
const dirty = ref(false)
const settingsOpen = ref(false)
const assistantOpen = ref(false)
const editorRef = ref<InstanceType<typeof RichEditor> | null>(null)

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

const relationTypeOptions: AutocompleteOption[] = RELATION_TYPES.map((t) => ({ value: t, label: t }))

const projectOptions = computed<AutocompleteOption[]>(() =>
  projects.items.map((p) => ({ value: p.projectId, label: p.name, meta: p.documentCount })),
)
const categoryOptions = computed<AutocompleteOption[]>(() =>
  DOCUMENT_CATEGORIES.map((c) => ({ value: c, label: c })),
)
const parentOptions = computed<AutocompleteOption[]>(() => [
  { value: TOP_LEVEL, label: 'Top level' },
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
  () => projects.items.find((p) => p.projectId === projectId.value)?.name ?? 'Project',
)

watch([body, title], () => {
  if (!loading.value) dirty.value = true
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
    const [detail, content] = await Promise.all([
      apiFetch<DocumentDetailResponse>(`/v1/documents/${editId.value}`),
      apiFetch<DocumentContentResponse>(`/v1/documents/${editId.value}/content`),
    ])
    title.value = detail.document.title
    category.value = detail.document.category
    parentId.value = detail.document.parentId ?? ''
    projectId.value = detail.document.projectId
    headRevisionId.value = detail.document.headRevisionId
    body.value = content.markdown
    const fm = content.frontmatter ?? {}
    if (Array.isArray(fm.relations)) {
      relationRows.value = (fm.relations as Array<Record<string, unknown>>)
        .map((r) => {
          const target = r.target
          if (typeof target === 'string') return { type: String(r.type ?? ''), key: target, name: '' }
          if (target && typeof target === 'object') {
            const t = target as Record<string, unknown>
            return { type: String(r.type ?? ''), key: String(t.key ?? ''), name: String(t.name ?? '') }
          }
          return null
        })
        .filter((r): r is RelationRow => r !== null && !!r.type && !!r.key)
    }
    if (Array.isArray(fm.tags)) tags.value = (fm.tags as string[]).join(', ')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    loading.value = false
    dirty.value = false
  }
})

/** Frontmatter `relations:`/`tags:` become graph edges via the deterministic extractor (worker step 7). */
function buildSource(markdown: string): string {
  const rows = relationRows.value.filter((r) => r.type && r.key.trim())
  const tagList = tags.value.split(',').map((t) => t.trim()).filter(Boolean)
  if (rows.length === 0 && tagList.length === 0) return markdown
  const lines: string[] = ['---']
  if (rows.length > 0) {
    lines.push('relations:')
    for (const r of rows) {
      const key = r.key.trim()
      const entityType = key.includes(':') ? key.slice(0, key.indexOf(':')) : 'entity'
      const name = r.name.trim() || key.split(':').pop() || key
      lines.push(`  - type: ${r.type}`)
      lines.push(`    target: { type: ${JSON.stringify(entityType)}, key: ${JSON.stringify(key)}, name: ${JSON.stringify(name)} }`)
    }
  }
  if (tagList.length > 0) {
    lines.push(`tags: [${tagList.map((t) => JSON.stringify(t)).join(', ')}]`)
  }
  lines.push('---', '')
  return `${lines.join('\n')}${markdown}`
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
    toast.error('Pick a project in page settings before attaching files')
    settingsOpen.value = true
    return null
  }
  try {
    const markdown = editorRef.value?.flush() ?? body.value
    const res = await apiFetch<CreateDocumentResponse>('/v1/documents', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        projectId: projectId.value,
        title: title.value.trim() || 'Untitled page',
        category: category.value,
        ...(parentId.value ? { parentId: parentId.value } : {}),
        content: { mode: 'inline', format: 'markdown', text: buildSource(markdown) },
      }),
    })
    editId.value = res.documentId
    headRevisionId.value = res.revisionId
    void store.fetchList()
    // Keep the URL honest without unmounting the editor mid-upload.
    await router.replace(`/documents/${res.documentId}/edit`)
    toast.success('Draft page created so files can be attached')
    return res.documentId
  } catch (e) {
    toast.error((e as Error).message)
    return null
  }
}

async function save() {
  const markdown = editorRef.value?.flush() ?? body.value
  if (!title.value.trim() || !markdown.trim()) {
    toast.error('Title and content are required')
    return
  }
  if (!projectId.value) {
    toast.error('Pick a project for this page')
    settingsOpen.value = true
    return
  }
  busy.value = true
  try {
    const text = buildSource(markdown)
    if (!isEdit.value) {
      const res = await apiFetch<CreateDocumentResponse>('/v1/documents', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: getWorkspaceId(),
          projectId: projectId.value,
          title: title.value,
          category: category.value,
          ...(parentId.value ? { parentId: parentId.value } : {}),
          content: { mode: 'inline', format: 'markdown', text },
        }),
      })
      dirty.value = false
      toast.success('Document created — indexing started')
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
    const revision = await apiFetch<RevisionInfo>(`/v1/documents/${editId.value}/revisions`, {
      method: 'POST',
      headers: headRevisionId.value ? { 'If-Match': headRevisionId.value } : {},
      body: JSON.stringify({ message: message.value || 'Edited in web editor', contentType: 'text/markdown' }),
    })
    const up = await apiFetch<CreateUploadResponse>(`/v1/documents/${editId.value}/uploads`, {
      method: 'POST',
      body: JSON.stringify({ revisionId: revision.revisionId, contentType: 'text/markdown', filename: 'source.md' }),
    })
    const putRes = await fetch(up.upload.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: text,
    })
    if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)
    const fin = await apiFetch<FinalizeRevisionResponse>(
      `/v1/documents/${editId.value}/revisions/${revision.revisionId}/finalize`,
      { method: 'POST' },
    )
    dirty.value = false
    toast.success(fin.deduplicated ? 'No content changes — metadata updated' : 'Revision published — indexing started')
    await router.push(`/documents/${editId.value}`)
  } catch (e) {
    const msg = (e as Error).message
    if (msg.startsWith('409')) {
      toast.error('The document head moved while you were editing — reload and compare before retrying')
    } else {
      toast.error(msg)
    }
  } finally {
    busy.value = false
  }
}

/* ------------------------------------------------- unsaved-changes guard */

const confirmOpen = ref(false)
/** Where the interrupted navigation was heading, replayed once confirmed. */
let pendingLeave: (() => void) | null = null

function destination(): string {
  return editId.value ? `/documents/${editId.value}` : '/documents'
}

function cancel() {
  if (!dirty.value) {
    void router.push(destination())
    return
  }
  pendingLeave = () => void router.push(destination())
  confirmOpen.value = true
}

function discardAndLeave() {
  dirty.value = false
  confirmOpen.value = false
  const go = pendingLeave
  pendingLeave = null
  go?.()
}

// In-app navigation: the router asks first. Publishing clears `dirty`, so a
// successful save never triggers this.
onBeforeRouteLeave((to) => {
  if (!dirty.value || busy.value) return true
  pendingLeave = () => void router.push(to.fullPath)
  confirmOpen.value = true
  return false
})

// Closing the tab or hitting reload is the browser's own dialog — a custom one
// cannot be shown there, and suppressing the native prompt would mean losing
// the draft silently.
function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value) return
  event.preventDefault()
  event.returnValue = ''
}
if (!import.meta.env.SSR) window.addEventListener('beforeunload', beforeUnload)
onBeforeUnmount(() => {
  if (!import.meta.env.SSR) window.removeEventListener('beforeunload', beforeUnload)
})
</script>

<template>
  <div class="kn-page-editor">
    <header class="kn-page-head">
      <div class="kn-page-crumb">
        <strong>{{ projectName }}</strong>
        <span class="kn-page-state">{{ isEdit ? 'Editing' : 'New page' }}</span>
        <span v-if="dirty" class="kn-dirty-dot" title="Unsaved changes" />
      </div>

      <div class="ml-auto flex items-center gap-1.5">
        <Button variant="ghost" size="sm" @click="assistantOpen = !assistantOpen">
          <Sparkles class="size-4" /> <span class="hidden sm:inline">AI</span>
        </Button>
        <Button variant="ghost" size="sm" @click="settingsOpen = true">
          <Settings2 class="size-4" /> <span class="hidden sm:inline">Settings</span>
        </Button>
        <Button variant="ghost" size="sm" @click="cancel">Cancel</Button>
        <Button size="sm" :disabled="busy || loading" @click="save">
          {{ busy ? 'Saving…' : isEdit ? 'Publish' : 'Create & index' }}
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

        <RichEditor
          v-else
          ref="editorRef"
          v-model="body"
          :pages="mentionablePages"
          :resolve-document-id="ensureDocumentId"
        >
          <template #lede>
            <textarea
              v-model="title"
              class="kn-title-input"
              rows="1"
              placeholder="Page title"
              aria-label="Page title"
              spellcheck="false"
              @keydown.enter.prevent="editorRef?.focus()"
            />
          </template>
        </RichEditor>
      </div>

      <!-- The assistant page's own chat, pinned to this page: same composer,
           same modes, same thread history — an editor-only variant would drift
           from it within a release. -->
      <aside v-if="assistantOpen" class="kn-page-rail">
        <div class="kn-rail-head">
          <h2 class="text-sm font-semibold">Assistant</h2>
          <Button variant="ghost" size="icon-sm" aria-label="Close assistant" @click="assistantOpen = false">
            <X class="size-4" />
          </Button>
        </div>
        <ChatPane v-if="editId" :document-id="editId" class="kn-rail-chat" />
        <p v-else class="p-4 text-sm text-muted-foreground">
          Save the page once and the assistant can read it, edit it, and answer questions about it.
        </p>
      </aside>
    </div>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Discard unpublished changes?</AlertDialogTitle>
          <AlertDialogDescription>
            This page has edits that were never published, so they exist only in this tab.
            Leaving now throws them away.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel @click="pendingLeave = null">Keep editing</AlertDialogCancel>
          <AlertDialogAction
            class="bg-destructive text-white hover:bg-destructive/90"
            @click="discardAndLeave"
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    <!-- Page settings: everything that is metadata rather than the page. -->
    <Sheet v-model:open="settingsOpen">
      <SheetContent side="right" class="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Page settings</SheetTitle>
          <SheetDescription>
            Placement and the deterministic facts this page asserts into the graph.
          </SheetDescription>
        </SheetHeader>

        <div class="space-y-5 px-4 pb-8">
          <Autocomplete
            v-model="projectSelection"
            label="Project"
            placeholder="Search projects…"
            :options="projectOptions"
            :multiple="false"
            empty-hint="No projects in this workspace yet."
          />

          <Autocomplete
            v-model="parentSelection"
            label="Parent page"
            placeholder="Search pages…"
            :options="parentOptions"
            :multiple="false"
          />

          <Autocomplete
            v-model="categorySelection"
            label="Category"
            placeholder="Search categories…"
            :options="categoryOptions"
            :multiple="false"
          />

          <div v-if="isEdit" class="space-y-1.5">
            <Label for="editor-message" class="kn-field-label">Revision message</Label>
            <Input id="editor-message" v-model="message" placeholder="What changed?" class="h-8 text-xs" />
          </div>

          <div class="space-y-2 border-t pt-5">
            <div class="space-y-1">
              <h3 class="kn-field-label">Relations</h3>
              <p class="text-xs leading-snug text-muted-foreground">
                Written to frontmatter and indexed as graph facts with full confidence.
              </p>
            </div>
            <div v-for="(row, i) in relationRows" :key="i" class="grid grid-cols-[1fr_auto] gap-2">
              <div class="space-y-2">
                <Autocomplete
                  :model-value="[row.type]"
                  :label="`Relation ${i + 1} type`"
                  hide-label
                  placeholder="Relation type…"
                  :options="relationTypeOptions"
                  :multiple="false"
                  @update:model-value="row.type = $event[0] ?? row.type"
                />
                <Input v-model="row.key" placeholder="service:identity" class="h-8 font-mono text-xs" />
                <Input v-model="row.name" placeholder="Display name (optional)" class="h-8 text-xs" />
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                :aria-label="`Remove relation ${i + 1}`"
                @click="relationRows.splice(i, 1)"
              >
                <X class="size-4" />
              </Button>
            </div>
            <Button
              size="sm"
              variant="outline"
              @click="relationRows.push({ type: 'DEPENDS_ON', key: '', name: '' })"
            >
              Add relation
            </Button>
          </div>

          <div class="space-y-1.5">
            <Label for="editor-tags" class="kn-field-label">Tags</Label>
            <Input id="editor-tags" v-model="tags" placeholder="tags, comma, separated" class="h-8 text-xs" />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  </div>
</template>
