<script setup lang="ts">
/**
 * Writing a QA test fixture (#483): a new one at `/create/fixture`, a new
 * revision at `/documents/:id/fixture`.
 *
 * Two views over one draft. **Steps** is the structured editor — operations
 * picked from the specs the author can open, request rows, captures — and
 * **YAML** is the same body as text, for pasting or a bulk edit. Switching
 * converts; a YAML tab that does not parse stays open with the parser's error
 * rather than discarding what was typed.
 *
 * The server validates, exactly as the spec editor's does: a refused finalize
 * is a 400 whose `details.issues` name a step, and they are shown on that
 * step. The draft revision it left is reused by the next save.
 */
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useQueryClient } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, StickyNote } from 'lucide-vue-next'
import {
  fixtureCallKey,
  structuredContentType,
  type ApiSpecSyntax,
  type DocumentContentResponse,
  type DocumentDetailResponse,
  type FixtureIssueInfo,
  type TestFixtureResponse,
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
import ApiTabs from '@/modules/api-reference/components/ApiTabs.vue'
import FixtureRows from '@/modules/api-reference/components/FixtureRows.vue'
import FixtureStepCard from '@/modules/api-reference/components/FixtureStepCard.vue'
import type { PickedOperation } from '@/modules/api-reference/components/ApiOperationPicker.vue'
import {
  BodyError,
  emptyCall,
  fromText,
  nextId,
  STARTER,
  toText,
  type FixtureDraft,
  type StepDraft,
} from '@/modules/api-reference/model/test-fixture'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const queryClient = useQueryClient()

const editId = computed(() => (typeof route.params.id === 'string' ? route.params.id : null))
const workspaceId = getWorkspaceId()
const title = ref('')
const syntax = ref<ApiSpecSyntax>('yaml')
const view = ref<'steps' | 'text'>('steps')
const draft = ref<FixtureDraft>(fromText(STARTER))
const text = ref('')
const textError = ref<string | null>(null)
const bodyError = ref<BodyError | null>(null)
const loading = ref(false)
const loadError = ref<string | null>(null)
const saving = ref(false)
const issues = ref<FixtureIssueInfo[]>([])
const pendingRevision = ref<string | null>(null)
/** What each picked or server-resolved key is, for the step's endpoint chip. */
const operations = ref(new Map<string, { method: string | null; path: string; specTitle: string }>())
const tabs = ref<InstanceType<typeof ApiTabs> | null>(null)

onMounted(async () => {
  if (!editId.value) return
  loading.value = true
  try {
    const path = { id: editId.value }
    // Fresh: the text is what the next revision is written over.
    const [detail, content, parsed] = (await Promise.all([
      fetchApi(queryClient, '/v1/documents/{id}', { path }, { fresh: true }),
      fetchApi(queryClient, '/v1/documents/{id}/content', { path }, { fresh: true }),
      fetchApi(queryClient, '/v1/test-fixtures/{id}', { path }, { fresh: true }).catch(() => null),
    ])) as [DocumentDetailResponse, DocumentContentResponse, TestFixtureResponse | null]
    title.value = detail.document.title
    syntax.value = content.contentType.includes('json') ? 'json' : 'yaml'
    text.value = content.markdown
    for (const c of parsed?.calls ?? []) if (c.operation) operations.value.set(c.entityKey, c.operation)
    try {
      draft.value = fromText(content.markdown)
    } catch (e) {
      // A body that no longer parses opens as text, with the reason.
      view.value = 'text'
      textError.value = (e as Error).message.split('\n')[0]
    }
  } catch (e) {
    loadError.value = errorMessage(e, t)
  } finally {
    loading.value = false
  }
})

/** Switch views, converting the draft; a refusal keeps the current view. */
function switchView(next: string) {
  if (next === view.value) return
  if (next === 'text') {
    if (!syncText()) return
    view.value = 'text'
    return
  }
  try {
    draft.value = fromText(text.value)
    textError.value = null
    view.value = 'steps'
  } catch (e) {
    textError.value = (e as Error).message.split('\n')[0]
  }
}

function syncText(): boolean {
  try {
    text.value = toText(draft.value, syntax.value)
    bodyError.value = null
    return true
  } catch (e) {
    if (!(e instanceof BodyError)) throw e
    bodyError.value = e
    return false
  }
}

const stepIds = () => [...draft.value.steps, ...draft.value.teardown].map((s) => s.id)

function addStep(kind: 'call' | 'manual') {
  const id = nextId(stepIds())
  draft.value.steps.push(kind === 'call' ? emptyCall(id) : { kind: 'manual', id, manual: '' })
}

function addTeardown() {
  draft.value.teardown.push(emptyCall(nextId(stepIds(), 'teardown')))
}

function move<T>(list: T[], i: number, by: -1 | 1) {
  const j = i + by
  if (j < 0 || j >= list.length) return
  ;[list[i], list[j]] = [list[j], list[i]]
}

function picked(op: PickedOperation) {
  operations.value.set(op.entityKey, { method: op.method, path: op.path, specTitle: op.specTitle })
}

/** Issues by where they point: `steps[2]…` and `teardown[0]…` go to that card, the rest above the steps. */
function issuesAt(section: 'steps' | 'teardown', index: number) {
  const prefix = `${section}[${index}]`
  return issues.value.filter((i) => i.path === prefix || i.path.startsWith(`${prefix}.`))
}
// The YAML view has no cards, so every issue is listed above it.
const generalIssues = computed(() =>
  view.value === 'text' ? issues.value : issues.value.filter((i) => !/^(steps|teardown)\[\d+\]/u.test(i.path)),
)

function refusal(e: unknown): boolean {
  if (isApiRequestError(e) && e.status === 400 && Array.isArray(e.details?.issues)) {
    issues.value = e.details.issues as FixtureIssueInfo[]
    return true
  }
  return false
}

async function save() {
  issues.value = []
  if (!title.value.trim()) {
    toast.error(t('testFixture.titleRequired'))
    return
  }
  if (view.value === 'steps' && !syncText()) return
  if (view.value === 'text') {
    try {
      fromText(text.value)
      textError.value = null
    } catch (e) {
      textError.value = (e as Error).message.split('\n')[0]
      return
    }
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
      workspaceId,
      // Required by the API; a workspace with no project yet is refused with its validation message, as before.
      projectId: projectId ?? '',
      ...(typeof route.query.parent === 'string' ? { parentId: route.query.parent } : {}),
      title: title.value.trim(),
      kind: 'test-fixture',
      content: { mode: 'inline', format: syntax.value, text: text.value },
    },
  })
  toast.success(t('testFixture.created'))
  return res.documentId
}

/** Upload straight to storage, then finalize — the spec editor's path. */
async function saveRevision(documentId: string): Promise<string> {
  const contentType = structuredContentType('test-fixture', syntax.value)
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
    toast.success(fin.deduplicated ? t('apiSpecEditor.unchanged') : t('testFixture.saved'))
  } catch (e) {
    pendingRevision.value = revisionId
    throw e
  }
  return documentId
}

const viewTabs = computed(() => [
  { id: 'steps', label: t('testFixture.viewSteps') },
  { id: 'text', label: syntax.value === 'json' ? 'JSON' : 'YAML' },
])
const bodyInvalid = (section: 'steps' | 'teardown', i: number) => bodyError.value?.section === section && bodyError.value.index === i
/** A call as written (`op:billing:POST /invoices/{id}`) finds the operation under its folded key. */
const operationOf = (s: StepDraft) => (s.kind === 'call' ? (operations.value.get(fixtureCallKey(s.call) ?? s.call) ?? null) : null)
</script>

<template>
  <PageLayout variant="prose" :title="editId ? title || t('testFixture.editHeading') : t('testFixture.newHeading')">
    <PageState v-if="loadError" state="error" :description="loadError" />
    <PageState v-else-if="loading" state="loading" :rows="1" row-class="h-96" />
    <form v-else class="space-y-6" @submit.prevent="save">
      <div class="grid gap-4 sm:grid-cols-[minmax(0,1fr)_7rem]">
        <div class="space-y-1.5">
          <Label for="fixture-title">{{ t('apiSpecEditor.title') }}</Label>
          <Input id="fixture-title" v-model="title" :placeholder="t('testFixture.titlePlaceholder')" />
        </div>
        <div class="space-y-1.5">
          <Label for="fixture-syntax">{{ t('apiSpecEditor.syntax') }}</Label>
          <Select v-model="syntax">
            <SelectTrigger id="fixture-syntax" class="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="yaml">{{ t('apiRef.syntax.yaml') }}</SelectItem>
              <SelectItem value="json">{{ t('apiRef.syntax.json') }}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div class="space-y-3">
        <ApiTabs ref="tabs" :model-value="view" :tabs="viewTabs" :label="t('testFixture.viewLabel')" @update:model-value="switchView" />

        <div
          v-if="generalIssues.length"
          role="alert"
          class="space-y-1 border-y border-destructive/30 py-3 text-sm"
        >
          <p class="font-medium text-destructive">{{ t('testFixture.invalid', { n: issues.length }, issues.length) }}</p>
          <ul class="space-y-1">
            <li v-for="(i, n) in generalIssues" :key="n" class="flex flex-wrap gap-x-2">
              <code v-if="i.path" class="font-mono text-xs text-muted-foreground">{{ i.path }}</code>
              <span>{{ i.message }}</span>
            </li>
          </ul>
        </div>
        <p v-else-if="issues.length" role="alert" class="text-destructive text-sm font-medium">
          {{ t('testFixture.invalid', { n: issues.length }, issues.length) }}
        </p>

        <div v-if="view === 'steps'" :id="tabs?.panelId('steps')" role="tabpanel" :aria-labelledby="tabs?.tabId('steps')" class="space-y-8">
          <div class="space-y-1.5">
            <Label for="fixture-description">{{ t('testFixture.description') }}</Label>
            <Textarea id="fixture-description" v-model="draft.description" :placeholder="t('testFixture.descriptionPlaceholder')" class="min-h-16 text-ui" />
          </div>

          <section class="space-y-2" aria-labelledby="fixture-inputs">
            <h2 id="fixture-inputs" class="font-display text-base font-semibold">{{ t('testFixture.inputs') }}</h2>
            <p class="text-muted-foreground text-ui">{{ t('testFixture.inputsHint') }}</p>
            <FixtureRows
              v-model="draft.inputs"
              mono
              legend-hidden
              :legend="t('testFixture.inputs')"
              :name-placeholder="t('testFixture.inputName')"
              :value-placeholder="t('testFixture.inputDefault')"
              :add-label="t('testFixture.addInput')"
            />
          </section>

          <section class="space-y-3" aria-labelledby="fixture-setup">
            <div class="space-y-1">
              <h2 id="fixture-setup" class="font-display text-base font-semibold">{{ t('testFixture.setup') }}</h2>
              <p class="text-muted-foreground text-ui">{{ t('testFixture.setupHint') }}</p>
            </div>
            <ol class="space-y-3">
              <FixtureStepCard
                v-for="(s, i) in draft.steps"
                :key="i"
                v-model="draft.steps[i]"
                :workspace-id="workspaceId"
                :number="i + 1"
                :operation="operationOf(s)"
                :issues="issuesAt('steps', i)"
                :first="i === 0"
                :last="i === draft.steps.length - 1"
                :body-invalid="bodyInvalid('steps', i)"
                @pick="picked"
                @move="(by) => move(draft.steps, i, by)"
                @remove="draft.steps.splice(i, 1)"
              />
            </ol>
            <div class="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" @click="addStep('call')"><Plus class="size-3.5" /> {{ t('testFixture.addCall') }}</Button>
              <Button type="button" variant="ghost" size="sm" @click="addStep('manual')"><StickyNote class="size-3.5" /> {{ t('testFixture.addManual') }}</Button>
            </div>
          </section>

          <section class="space-y-3" aria-labelledby="fixture-teardown">
            <div class="space-y-1">
              <h2 id="fixture-teardown" class="font-display text-base font-semibold">{{ t('testFixture.teardown') }}</h2>
              <p class="text-muted-foreground text-ui">{{ t('testFixture.teardownHint') }}</p>
            </div>
            <ol v-if="draft.teardown.length" class="space-y-3">
              <FixtureStepCard
                v-for="(s, i) in draft.teardown"
                :key="i"
                v-model="draft.teardown[i]"
                :workspace-id="workspaceId"
                :number="i + 1"
                :operation="operationOf(s)"
                :issues="issuesAt('teardown', i)"
                :first="i === 0"
                :last="i === draft.teardown.length - 1"
                :body-invalid="bodyInvalid('teardown', i)"
                @pick="picked"
                @move="(by) => move(draft.teardown, i, by)"
                @remove="draft.teardown.splice(i, 1)"
              />
            </ol>
            <Button type="button" variant="outline" size="sm" @click="addTeardown"><Plus class="size-3.5" /> {{ t('testFixture.addTeardown') }}</Button>
          </section>
        </div>

        <div v-else :id="tabs?.panelId('text')" role="tabpanel" :aria-labelledby="tabs?.tabId('text')" class="space-y-1.5">
          <Label for="fixture-body" class="sr-only">{{ t('testFixture.body') }}</Label>
          <Textarea
            id="fixture-body"
            v-model="text"
            spellcheck="false"
            autocapitalize="off"
            wrap="off"
            :aria-invalid="!!textError || undefined"
            :aria-describedby="textError ? 'fixture-text-error' : 'fixture-text-hint'"
            class="min-h-[30rem] resize-y overflow-x-auto font-mono text-ui leading-relaxed whitespace-pre [tab-size:2]"
          />
          <p v-if="textError" id="fixture-text-error" role="alert" class="text-destructive text-ui">{{ t('testFixture.textInvalid', { reason: textError }) }}</p>
          <p v-else id="fixture-text-hint" class="text-muted-foreground text-ui">{{ t('testFixture.textHint') }}</p>
        </div>
      </div>

      <div class="flex justify-end gap-2">
        <Button variant="ghost" as-child>
          <RouterLink :to="editId ? `/documents/${editId}` : '/documents'">{{ t('common.cancel') }}</RouterLink>
        </Button>
        <Button type="submit" :disabled="saving">
          {{ saving ? t('apiSpecEditor.saving') : editId ? t('apiSpecEditor.publish') : t('testFixture.create') }}
        </Button>
      </div>
    </form>
  </PageLayout>
</template>
