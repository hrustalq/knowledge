<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type {
  CreateDocumentResponse,
  CreateUploadResponse,
  FinalizeRevisionResponse,
} from '@knowledge/contracts'
import { DOCUMENT_CATEGORIES, type DocumentCategory } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { useProjectsStore } from '@/stores/projects'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const router = useRouter()
const projects = useProjectsStore()
const title = ref('')
const text = ref('')
const category = ref<DocumentCategory>('other')
const projectId = ref(projects.activeId ?? '')
const busy = ref(false)

onMounted(() => {
  if (!projects.loaded) {
    void projects.fetchList().then(() => {
      if (!projectId.value) projectId.value = projects.activeId ?? ''
    })
  }
})

async function submit() {
  if (!title.value.trim() || !text.value.trim()) {
    toast.error('Title and markdown content are required')
    return
  }
  if (!projectId.value) {
    toast.error('Pick a project for this page')
    return
  }
  busy.value = true
  try {
    // 1. Create document (draft revision)
    const doc = await apiFetch<CreateDocumentResponse>('/v1/documents', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        projectId: projectId.value,
        title: title.value,
        category: category.value,
      }),
    })

    // 2. Presigned upload straight to MinIO
    const up = await apiFetch<CreateUploadResponse>(`/v1/documents/${doc.documentId}/uploads`, {
      method: 'POST',
      body: JSON.stringify({
        revisionId: doc.revisionId,
        contentType: 'text/markdown',
        filename: 'source.md',
      }),
    })
    const putRes = await fetch(up.upload.url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/markdown' },
      body: text.value,
    })
    if (!putRes.ok) throw new Error(`Upload failed: ${putRes.status}`)

    // 3. Finalize → queues ingestion
    const fin = await apiFetch<FinalizeRevisionResponse>(
      `/v1/documents/${doc.documentId}/revisions/${up.revisionId}/finalize`,
      { method: 'POST' },
    )

    toast.success(fin.deduplicated ? 'Identical content — reused existing revision' : 'Uploaded — indexing started')
    await router.push(`/documents/${doc.documentId}`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Card class="mx-auto max-w-2xl">
    <CardHeader><CardTitle>Upload a document</CardTitle></CardHeader>
    <CardContent class="space-y-4">
      <Input v-model="title" placeholder="Title, e.g. Authentication Architecture" />
      <label class="flex items-center gap-2 text-sm">
        <span class="text-muted-foreground">Project</span>
        <select v-model="projectId" class="flex-1 rounded-md border bg-background px-2 py-1.5">
          <option v-for="p in projects.items" :key="p.projectId" :value="p.projectId">{{ p.name }}</option>
        </select>
      </label>
      <label class="flex items-center gap-2 text-sm">
        <span class="text-muted-foreground">Category</span>
        <select v-model="category" class="rounded-md border bg-background px-2 py-1.5">
          <option v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>
      <Textarea v-model="text" rows="14" placeholder="# Markdown content…" class="font-mono" />
      <Button :disabled="busy" @click="submit">
        {{ busy ? 'Uploading…' : 'Upload & index' }}
      </Button>
    </CardContent>
  </Card>
</template>
