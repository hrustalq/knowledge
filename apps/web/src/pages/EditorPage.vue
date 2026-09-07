<script setup lang="ts">
// Feature 03 (docs/features/03): markdown editor with live preview,
// frontmatter relations, document references and the AI panel (feature 09).
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
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
import { nativeEl } from '@/lib/utils'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import AssistantPanel from '@/components/knowledge/AssistantPanel.vue'

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

const editId = computed(() => (route.params.id as string | undefined) ?? null)
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
const showPreview = ref(true)
const editorEl = ref<HTMLTextAreaElement | null>(null)
const setEditorEl = (c: unknown) => {
  editorEl.value = nativeEl<HTMLTextAreaElement>(c)
}

// reka-ui reserves '' as the Select's "cleared" value and rejects it on an
// item, so the top-level choice rides a sentinel.
const TOP_LEVEL = '__root__'
const parentModel = computed({
  get: () => parentId.value || TOP_LEVEL,
  set: (v: string) => {
    parentId.value = v === TOP_LEVEL ? '' : v
  },
})

// The doc-reference picker is an action, not a field — picking a page inserts
// a link and the control must go back to reading "Doc reference…". reka-ui's
// model is passive (it keeps its own copy even when the parent never writes
// one back), so the reset is a remount rather than a value assignment.
const docRefKey = ref(0)

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
  }
})

/** Frontmatter `relations:`/`tags:` become graph edges via the deterministic extractor (worker step 7). */
function buildSource(): string {
  const rows = relationRows.value.filter((r) => r.type && r.key.trim())
  const tagList = tags.value.split(',').map((t) => t.trim()).filter(Boolean)
  if (rows.length === 0 && tagList.length === 0) return body.value
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
  return `${lines.join('\n')}${body.value}`
}

function insert(before: string, after = '', placeholder = '') {
  const el = editorEl.value
  if (!el) {
    body.value += before + placeholder + after
    return
  }
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = body.value.slice(start, end) || placeholder
  body.value = body.value.slice(0, start) + before + selected + after + body.value.slice(end)
  void Promise.resolve().then(() => {
    el.focus()
    el.selectionStart = start + before.length
    el.selectionEnd = start + before.length + selected.length
  })
}

// Untyped param: without a bound model the Select falls back to its widest
// value type, so narrow here instead of casting at the call site.
function insertDocRef(value: unknown) {
  const id = typeof value === 'string' ? value : ''
  if (!id) return
  const doc = store.items.find((d) => d.documentId === id)
  if (doc) insert(`[${doc.title}](/documents/${doc.documentId})`)
  docRefKey.value += 1
}

const MERMAID_SNIPPET = '\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n'
const TABLE_SNIPPET = '\n| Column | Column |\n| --- | --- |\n| cell | cell |\n'

async function save() {
  if (!title.value.trim() || !body.value.trim()) {
    toast.error('Title and content are required')
    return
  }
  if (!projectId.value) {
    toast.error('Pick a project for this page')
    return
  }
  busy.value = true
  try {
    const text = buildSource()
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

function appendSuggestion(text: string) {
  body.value = `${body.value.replace(/\s+$/, '')}\n\n${text}\n`
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex items-center justify-between">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ isEdit ? 'Edit document' : 'New document' }}</h1>
      <Button :disabled="busy || loading" @click="save">
        {{ busy ? 'Saving…' : isEdit ? 'Publish revision' : 'Create & index' }}
      </Button>
    </div>

    <div class="grid gap-4 lg:grid-cols-[1fr_320px]">
      <div class="space-y-4">
        <!-- Metadata -->
        <div class="grid gap-3 sm:grid-cols-3">
          <Input v-model="title" placeholder="Title" class="sm:col-span-3" />
          <div class="flex items-center gap-2 text-sm sm:col-span-3">
            <Label for="editor-project" class="font-normal text-muted-foreground">Project</Label>
            <Select v-model="projectId">
              <SelectTrigger id="editor-project" class="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="p in projects.items" :key="p.projectId" :value="p.projectId">
                  {{ p.name }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex items-center gap-2 text-sm">
            <Label for="editor-category" class="font-normal text-muted-foreground">Category</Label>
            <Select v-model="category">
              <SelectTrigger id="editor-category" class="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ c }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="flex items-center gap-2 text-sm sm:col-span-2">
            <Label for="editor-parent" class="font-normal text-muted-foreground">Parent</Label>
            <Select v-model="parentModel">
              <SelectTrigger id="editor-parent" class="flex-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem :value="TOP_LEVEL">(top level)</SelectItem>
                <SelectItem
                  v-for="d in store.items.filter((d) => d.documentId !== editId)"
                  :key="d.documentId"
                  :value="d.documentId"
                >
                  {{ d.title }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Input v-if="isEdit" v-model="message" placeholder="Revision message" class="sm:col-span-3" />
        </div>

        <!-- Toolbar -->
        <div class="flex flex-wrap items-center gap-1 rounded-md border p-1.5 text-sm">
          <Button size="sm" variant="ghost" title="Heading" @click="insert('\n## ', '', 'Heading')">H2</Button>
          <Button size="sm" variant="ghost" class="font-bold" title="Bold" @click="insert('**', '**', 'bold')">B</Button>
          <Button size="sm" variant="ghost" class="italic" title="Italic" @click="insert('*', '*', 'italic')">I</Button>
          <Button size="sm" variant="ghost" class="font-mono" title="Inline code" @click="insert('`', '`', 'code')">&lt;/&gt;</Button>
          <Button size="sm" variant="ghost" title="Link" @click="insert('[', '](https://)', 'text')">Link</Button>
          <Button size="sm" variant="ghost" title="Table" @click="insert(TABLE_SNIPPET)">Table</Button>
          <Button size="sm" variant="ghost" title="Mermaid diagram" @click="insert(MERMAID_SNIPPET)">Diagram</Button>
          <Select :key="docRefKey" @update:model-value="insertDocRef">
            <SelectTrigger size="sm" class="text-xs" title="Insert a link to another document">
              <SelectValue placeholder="Doc reference…" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem v-for="d in store.items" :key="d.documentId" :value="d.documentId">
                {{ d.title }}
              </SelectItem>
            </SelectContent>
          </Select>
          <Label for="editor-preview" class="ml-auto gap-1.5 text-xs font-normal text-muted-foreground">
            <Checkbox id="editor-preview" v-model="showPreview" /> preview
          </Label>
        </div>

        <!-- Editor + preview -->
        <div class="grid gap-4" :class="showPreview ? 'xl:grid-cols-2' : ''">
          <!-- Textarea auto-sizes to content (field-sizing), so `rows` alone
               would collapse the editor — pin the height the way `rows="24"`
               used to, and let it grow with the preview pane's cap. -->
          <Textarea
            :ref="setEditorEl"
            v-model="body"
            class="min-h-[36rem] w-full p-3 font-mono text-sm"
            placeholder="# Markdown content…"
          />
          <div v-if="showPreview" class="max-h-[36rem] overflow-y-auto rounded-md border p-4">
            <MarkdownView :markdown="body" />
          </div>
        </div>

        <!-- Relations → frontmatter (deterministic facts) -->
        <Card>
          <CardHeader class="pb-2">
            <CardTitle class="text-sm">Relations & tags (indexed as graph facts)</CardTitle>
          </CardHeader>
          <CardContent class="space-y-2">
            <div v-for="(row, i) in relationRows" :key="i" class="flex gap-2">
              <Select v-model="row.type">
                <SelectTrigger class="text-sm" :aria-label="`Relation ${i + 1} type`">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="t in RELATION_TYPES" :key="t" :value="t">{{ t }}</SelectItem>
                </SelectContent>
              </Select>
              <Input v-model="row.key" placeholder="service:identity" class="font-mono text-sm" />
              <Input v-model="row.name" placeholder="Display name (optional)" class="text-sm" />
              <Button size="sm" variant="ghost" @click="relationRows.splice(i, 1)">✕</Button>
            </div>
            <div class="flex items-center gap-3">
              <Button size="sm" variant="outline" @click="relationRows.push({ type: 'DEPENDS_ON', key: '', name: '' })">
                + relation
              </Button>
              <Input v-model="tags" placeholder="tags, comma, separated" class="text-sm" />
            </div>
          </CardContent>
        </Card>
      </div>

      <!-- Feature 09: AI assistant sidebar -->
      <div>
        <AssistantPanel :title="title" :markdown="body" @append="appendSuggestion" />
      </div>
    </div>
  </div>
</template>
