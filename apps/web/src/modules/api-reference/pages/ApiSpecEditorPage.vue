<script setup lang="ts">
/**
 * Writing an API spec (#78, phase 3): a new spec at `/create/spec`, a new
 * revision of one at `/documents/:id/spec`.
 *
 * A spec is edited as text. The rich editor is a markdown tool and would be
 * wrong here, and a visual spec designer is out of scope. The server is the
 * validator: a spec that does not validate comes back as a 422 whose
 * `details.issues` are listed under the editor, and the draft revision it left
 * is reused on the next attempt instead of piling up drafts.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { FileUp } from 'lucide-vue-next'
import {
  apiSpecContentType,
  type ApiSpecKind,
  type ApiSpecSyntax,
  type DocumentContentResponse,
  type DocumentDetailResponse,
} from '@knowledge/contracts'
import { getProjectId, getWorkspaceId } from '@/shared/api/api'
import { api, fetchApi, isApiRequestError } from '@/shared/api/queries'
import { errorMessage } from '@/shared/api/errors'
import { presignedPut } from '@/shared/api/presigned-put'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Label } from '@/shared/ui/label'
import { Textarea } from '@/shared/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/shared/ui/select'
import { PageLayout, PageState } from '@/shared/layout'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()

const editId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null))
const title = ref('')
const kind = ref<ApiSpecKind>('openapi')
const syntax = ref<ApiSpecSyntax>('yaml')
const text = ref('')
const loading = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)
const issues = ref<Array<{ message: string; path?: string }>>([])
/** The draft a refused finalize left behind, reused by the next save. */
const pendingRevision = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

const STARTERS: Record<ApiSpecKind, string> = {
  openapi: `openapi: 3.1.0
info:
  title: My API
  version: '1.0'
paths:
  /health:
    get:
      summary: Health check
      responses:
        '200':
          description: OK
`,
  asyncapi: `asyncapi: 3.0.0
info:
  title: My events
  version: '1.0'
channels:
  userSignedUp:
    address: user/signedup
operations:
  onUserSignedUp:
    action: receive
    channel:
      $ref: '#/channels/userSignedUp'
`,
}

onMounted(async () => {
  if (!editId.value) {
    if (route.query.kind === 'asyncapi') kind.value = 'asyncapi'
    text.value = STARTERS[kind.value]
    return
  }
  loading.value = true
  try {
    const path = { id: editId.value }
    // Fresh: the text is what the next revision is written over.
    const [detail, content] = (await Promise.all([
      fetchApi(queryClient, '/v1/documents/{id}', { path }, { fresh: true }),
      fetchApi(queryClient, '/v1/documents/{id}/content', { path }, { fresh: true }),
    ])) as [DocumentDetailResponse, DocumentContentResponse]
    title.value = detail.document.title
    if (detail.document.kind === 'asyncapi') kind.value = 'asyncapi'
    syntax.value = content.contentType.includes('json') ? 'json' : 'yaml'
    text.value = content.markdown
  } catch (e) {
    loadError.value = errorMessage(e, t)
  } finally {
    loading.value = false
  }
})

function pickFile() {
  fileInput.value?.click()
}

async function onFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  text.value = await file.text()
  syntax.value = /\.json$/i.test(file.name) || text.value.trimStart().startsWith('{') ? 'json' : 'yaml'
  if (/^\s*["']?asyncapi["']?\s*:/m.test(text.value)) kind.value = 'asyncapi'
  else if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(text.value)) kind.value = 'openapi'
  if (!title.value) title.value = file.name.replace(/\.(ya?ml|json)$/i, '')
}

function refusal(e: unknown): boolean {
  if (isApiRequestError(e) && e.status === 422 && Array.isArray(e.details?.issues)) {
    issues.value = e.details.issues as typeof issues.value
    return true
  }
  return false
}

async function save() {
  issues.value = []
  if (!title.value.trim()) {
    toast.error(t('apiSpecEditor.titleRequired'))
    return
  }
  saving.value = true
  try {
    const id = editId.value ? await saveRevision(editId.value) : await create()
    if (id) await router.push(`/documents/${id}`)
  } catch (e) {
    if (!refusal(e)) toast.error(errorMessage(e, t))
  } finally {
    saving.value = false
  }
}

async function create(): Promise<string> {
  const projectId = getProjectId()
  // No category: the server picks it by kind (a spec's is `reference`).
  const res = await api.post('/v1/documents', {
    body: {
      workspaceId: getWorkspaceId(),
      // Required by the API; a workspace with no project yet is refused with its validation message, as before.
      projectId: projectId ?? '',
      ...(typeof route.query.parent === 'string' ? { parentId: route.query.parent } : {}),
      title: title.value.trim(),
      kind: kind.value,
      content: { mode: 'inline', format: syntax.value, text: text.value },
    },
  })
  toast.success(t('apiSpecEditor.created'))
  return res.documentId
}

/** Upload straight to storage, then finalize: the same path the page editor uses. */
async function saveRevision(documentId: string): Promise<string> {
  const contentType = apiSpecContentType(kind.value, syntax.value)
  let revisionId = pendingRevision.value
  if (!revisionId) {
    // No branch: the server picks the default one.
    const rev = await api.post('/v1/documents/{id}/revisions', {
      path: { id: documentId },
      body: { contentType },
    })
    revisionId = rev.revisionId
  }
  const up = await api.post('/v1/documents/{id}/uploads', {
    path: { id: documentId },
    body: { revisionId, contentType, filename: `source.${syntax.value}` },
    config: { timeout: 0 },
  })
  await presignedPut({ url: up.upload.url, headers: { 'Content-Type': contentType } }, new Blob([text.value], { type: contentType }))
  try {
    const fin = await api.post('/v1/documents/{id}/revisions/{revisionId}/finalize', {
      path: { id: documentId, revisionId },
      config: { timeout: 0 },
    })
    pendingRevision.value = null
    toast.success(fin.deduplicated ? t('apiSpecEditor.unchanged') : t('apiSpecEditor.saved'))
  } catch (e) {
    pendingRevision.value = revisionId
    throw e
  }
  return documentId
}
</script>

<template>
  <PageLayout variant="prose" :title="editId ? title || t('apiSpecEditor.editHeading') : t('apiSpecEditor.newHeading')">
    <PageState v-if="loadError" state="error" :description="loadError" />
    <PageState v-else-if="loading" state="loading" :rows="1" row-class="h-96" />
    <form v-else class="space-y-5" @submit.prevent="save">
      <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem_7rem]">
        <div class="space-y-1.5">
          <Label for="spec-title">{{ t('apiSpecEditor.title') }}</Label>
          <Input id="spec-title" v-model="title" :placeholder="t('apiSpecEditor.titlePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="spec-kind">{{ t('apiSpecEditor.kind') }}</Label>
          <Select v-model="kind" :disabled="!!editId">
            <SelectTrigger id="spec-kind" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="openapi">{{ t('apiRef.kind.openapi') }}</SelectItem>
              <SelectItem value="asyncapi">{{ t('apiRef.kind.asyncapi') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div class="space-y-1.5">
          <Label for="spec-syntax">{{ t('apiSpecEditor.syntax') }}</Label>
          <Select v-model="syntax">
            <SelectTrigger id="spec-syntax" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="yaml">{{ t('apiRef.syntax.yaml') }}</SelectItem>
              <SelectItem value="json">{{ t('apiRef.syntax.json') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div class="space-y-1.5">
        <div class="flex items-end justify-between gap-3">
          <Label for="spec-body">{{ t('apiSpecEditor.body') }}</Label>
          <Button variant="ghost" size="sm" type="button" @click="pickFile">
            <FileUp class="size-3.5" /> {{ t('apiSpecEditor.loadFile') }}
          </Button>
          <input ref="fileInput" type="file" accept=".yaml,.yml,.json" class="hidden" @change="onFile" />
        </div>
        <Textarea
          id="spec-body"
          v-model="text"
          spellcheck="false"
          autocapitalize="off"
          wrap="off"
          :aria-invalid="issues.length > 0 || undefined"
          :aria-describedby="issues.length ? 'spec-issues' : 'spec-hint'"
          class="min-h-[30rem] resize-y overflow-x-auto font-mono text-ui leading-relaxed whitespace-pre [tab-size:2]"
        />
        <p v-if="!issues.length" id="spec-hint" class="text-ui text-muted-foreground">
          {{ editId ? t('apiSpecEditor.kindFixed') : t('apiSpecEditor.hint') }}
        </p>
      </div>

      <div v-if="issues.length" id="spec-issues" role="alert" class="space-y-2 border-y border-destructive/30 py-3 text-sm">
        <p class="font-medium text-destructive">{{ t('apiSpecEditor.invalid', { n: issues.length }, issues.length) }}</p>
        <ul class="space-y-1">
          <li v-for="(i, n) in issues" :key="n" class="flex flex-wrap gap-x-2">
            <code v-if="i.path" class="font-mono text-xs text-muted-foreground">{{ i.path }}</code>
            <span>{{ i.message }}</span>
          </li>
        </ul>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" as-child>
          <RouterLink :to="editId ? `/documents/${editId}` : '/documents'">{{ t('common.cancel') }}</RouterLink>
        </Button>
        <Button type="submit" :disabled="saving">
          {{ saving ? t('apiSpecEditor.saving') : editId ? t('apiSpecEditor.publish') : t('apiSpecEditor.create') }}
        </Button>
      </div>
    </form>
  </PageLayout>
</template>
