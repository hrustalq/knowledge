<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { toast } from 'vue-sonner'
import type {
  CreateDocumentResponse,
  CreateUploadResponse,
  FinalizeRevisionResponse,
} from '@knowledge/contracts'
import { apiFetch, DEMO_WORKSPACE_ID } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

const router = useRouter()
const title = ref('')
const text = ref('')
const busy = ref(false)

async function submit() {
  if (!title.value.trim() || !text.value.trim()) {
    toast.error('Title and markdown content are required')
    return
  }
  busy.value = true
  try {
    // 1. Create document (draft revision)
    const doc = await apiFetch<CreateDocumentResponse>('/v1/documents', {
      method: 'POST',
      body: JSON.stringify({ workspaceId: DEMO_WORKSPACE_ID, title: title.value }),
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
      <Textarea v-model="text" rows="14" placeholder="# Markdown content…" class="font-mono" />
      <Button :disabled="busy" @click="submit">
        {{ busy ? 'Uploading…' : 'Upload & index' }}
      </Button>
    </CardContent>
  </Card>
</template>
