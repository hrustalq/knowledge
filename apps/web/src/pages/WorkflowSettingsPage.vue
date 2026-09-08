<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Plus, Workflow } from 'lucide-vue-next'
import type {
  ListWorkflowsResponse,
  ValidateWorkflowResponse,
  WorkflowDefinitionInfo,
  WorkflowGraph,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowValidationIssue,
} from '@knowledge/contracts'
import { KNOWN_EVENT_TYPES, DOCUMENT_CATEGORIES } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import WorkflowGraphEditor from '@/components/workflows/WorkflowGraphEditor.vue'
import WorkflowStepForm from '@/components/workflows/WorkflowStepForm.vue'

/**
 * The workflow settings tab (docs/features/17).
 *
 * Gated in the page on `auth.canAdminWorkspace` rather than by a router meta
 * flag, exactly as AI settings is: this is workspace administration, not
 * platform administration, so a member of another workspace is not the case
 * being defended against — the API's `admin` role is.
 */
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useWorkflowsStore()
const workspaceId = getWorkspaceId()

const canManage = computed(() => auth.canAdminWorkspace)

const TABS = [
  { key: 'definitions', label: 'Workflows' },
  { key: 'triggers', label: 'Triggers' },
] as const
type TabKey = (typeof TABS)[number]['key']
const tab = computed<TabKey>(() => {
  const q = route.query.tab
  return TABS.some((t) => t.key === q) ? (q as TabKey) : 'definitions'
})
function setTab(key: TabKey) {
  void router.replace({ query: { ...route.query, tab: key } })
}

const query = useQuery(apiQueryOptions('/v1/workflows', { query: { workspaceId } }))
const workflows = computed(() => (query.data.value as ListWorkflowsResponse | undefined)?.workflows ?? [])

const selectedId = ref<string | null>(null)
const selected = computed(() => workflows.value.find((w) => w.id === selectedId.value) ?? null)

// The draft is a local copy: the canvas fires on every drag, and writing each
// frame to the server would be both slow and unreviewable.
const draft = ref<{
  name: string
  description: string
  graph: WorkflowGraph
  trigger: WorkflowTrigger
  enabled: boolean
} | null>(null)
const selectedStepId = ref<string | null>(null)

watch(selected, (workflow) => {
  draft.value = workflow
    ? {
        name: workflow.name,
        description: workflow.description ?? '',
        graph: structuredClone(workflow.graph),
        trigger: structuredClone(workflow.trigger),
        enabled: workflow.enabled,
      }
    : null
  selectedStepId.value = null
})

const dirty = computed(() => {
  if (!selected.value || !draft.value) return false
  return (
    JSON.stringify({
      name: selected.value.name,
      description: selected.value.description ?? '',
      graph: selected.value.graph,
      trigger: selected.value.trigger,
      enabled: selected.value.enabled,
    }) !== JSON.stringify(draft.value)
  )
})

/**
 * Validation runs locally, against the very compiler the API will run. That is
 * the whole reason the machines live in a shared package: the editor can say
 * "this graph has a cycle" the instant you draw it, and be right.
 */
const issues = computed<WorkflowValidationIssue[]>(() =>
  draft.value ? validateGraph(draft.value.graph) : [],
)
const errors = computed(() => issues.value.filter((i) => i.severity === 'error'))
const graphIssues = computed(() => issues.value.filter((i) => !i.stepId))

const step = computed(() => draft.value?.graph.steps.find((s) => s.id === selectedStepId.value) ?? null)

function updateStep(next: WorkflowStep) {
  if (!draft.value) return
  draft.value.graph = {
    ...draft.value.graph,
    steps: draft.value.graph.steps.map((s) => (s.id === next.id ? next : s)),
  }
}

function removeStep(id: string) {
  if (!draft.value) return
  const layout = { ...(draft.value.graph.layout ?? {}) }
  delete layout[id]
  draft.value.graph = {
    // Edges into the deleted step go with it, or the graph keeps a dangling
    // reference the compiler would reject on save.
    steps: draft.value.graph.steps
      .filter((s) => s.id !== id)
      .map((s) => ({ ...s, next: s.next.filter((n) => n !== id) })),
    layout,
  }
  selectedStepId.value = null
}

const invalidates = () => [['/v1/workflows']]
const createWorkflow = useApiMutation('post', '/v1/workflows', { invalidates })
const updateWorkflow = useApiMutation('patch', '/v1/workflows/{id}', { invalidates })
const deleteWorkflow = useApiMutation('delete', '/v1/workflows/{id}', { invalidates })

const saving = ref(false)

async function createNew() {
  try {
    const created = (await createWorkflow.mutateAsync({
      body: {
        workspaceId,
        projectId: getProjectId(),
        name: `Workflow ${workflows.value.length + 1}`,
        graph: {
          steps: [
            {
              id: 'use-cases',
              kind: 'ai.generate',
              title: 'Use cases',
              next: [],
              fanOut: true,
              autoApprove: false,
              maxItems: 8,
              prompt: { user: 'List the use cases this entity participates in.' },
              produces: { category: 'use-case', relationToParent: 'IMPLEMENTS' },
            },
          ],
        },
      },
    })) as WorkflowDefinitionInfo
    await query.refetch()
    await store.refresh()
    selectedId.value = created.id
  } catch (e) {
    toast.error((e as Error).message)
  }
}

async function save() {
  if (!selected.value || !draft.value) return
  if (errors.value.length) {
    toast.error('Fix the highlighted problems before saving')
    return
  }
  saving.value = true
  try {
    await updateWorkflow.mutateAsync({
      path: { id: selected.value.id },
      body: {
        name: draft.value.name,
        description: draft.value.description || null,
        graph: draft.value.graph,
        trigger: draft.value.trigger,
        enabled: draft.value.enabled,
      },
    })
    await query.refetch()
    await store.refresh()
    toast.success('Workflow saved')
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

/** Re-seed the local draft from the stored row, throwing away canvas edits. */
function discard() {
  const workflow = selected.value
  if (!workflow) return
  draft.value = {
    name: workflow.name,
    description: workflow.description ?? '',
    graph: structuredClone(workflow.graph),
    trigger: structuredClone(workflow.trigger),
    enabled: workflow.enabled,
  }
  selectedStepId.value = null
}

async function remove(workflow: WorkflowDefinitionInfo) {
  if (!confirm(`Delete "${workflow.name}"? Its completed runs go with it.`)) return
  try {
    await deleteWorkflow.mutateAsync({ path: { id: workflow.id } })
    await query.refetch()
    await store.refresh()
    if (selectedId.value === workflow.id) selectedId.value = null
    toast.success('Workflow deleted')
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/**
 * A second opinion from the server. The local compiler is the same code, so
 * this is really a check that the definition the server *stored* still
 * compiles — worth having after someone else edited it in another tab.
 */
async function validateOnServer() {
  if (!selected.value || !draft.value) return
  try {
    const res = (await api.post('/v1/workflows/{id}/validate', {
      path: { id: selected.value.id },
      body: { graph: draft.value.graph },
    })) as ValidateWorkflowResponse
    toast[res.valid ? 'success' : 'error'](
      res.valid ? 'The server accepts this graph' : res.issues.map((i) => i.message).join(' '),
    )
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const TRIGGER_EVENTS = KNOWN_EVENT_TYPES.filter(
  (e) => e.startsWith('document.') || e.startsWith('revision.'),
)

function toggleTriggerEvent(event: string, on: boolean) {
  if (!draft.value) return
  draft.value.trigger = {
    ...draft.value.trigger,
    events: on ? [...draft.value.trigger.events, event] : draft.value.trigger.events.filter((e) => e !== event),
  }
}
function toggleTriggerCategory(category: string, on: boolean) {
  if (!draft.value) return
  const categories = draft.value.trigger.categories ?? []
  draft.value.trigger = {
    ...draft.value.trigger,
    categories: (on ? [...categories, category] : categories.filter((c) => c !== category)) as never,
  }
}
</script>

<template>
  <div class="flex min-h-0 w-full max-w-6xl flex-1 flex-col gap-5">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">Workflows</h1>
        <p class="text-muted-foreground mt-1 max-w-2xl text-sm">
          Step chains that turn one page into the next level of detail — an entity into use cases, a use case
          into API endpoints and screens. Every step parks its result for review before anything is published.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="!canManage" variant="outline">read-only — workspace admin required</Badge>
        <Button v-if="canManage" size="sm" @click="createNew">
          <Plus class="mr-1.5 size-4" /> New workflow
        </Button>
      </div>
    </header>

    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.key"
        role="tab"
        :aria-selected="tab === t.key"
        class="focus-visible:ring-ring rounded-t-sm border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="
          tab === t.key
            ? 'border-primary text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent'
        "
        @click="setTab(t.key)"
      >
        {{ t.label }}
      </button>
    </div>

    <div v-if="query.isLoading.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <div
      v-else-if="workflows.length === 0"
      class="text-muted-foreground flex flex-col items-center gap-3 rounded-lg border border-dashed py-14 text-center"
    >
      <Workflow class="size-8 opacity-40" />
      <div>
        <p class="text-foreground text-sm font-medium">No workflows yet</p>
        <p class="mx-auto mt-1 max-w-md text-sm">
          A workflow is a graph of steps. The classic one is three: an entity fans out into use cases, and each
          use case fans out into API endpoints and frontend pages.
        </p>
      </div>
      <Button v-if="canManage" size="sm" @click="createNew">
        <Plus class="mr-1.5 size-4" /> Create one
      </Button>
    </div>

    <div v-else class="grid min-h-0 gap-5 lg:grid-cols-[14rem_minmax(0,1fr)]">
      <aside class="space-y-1">
        <button
          v-for="workflow in workflows"
          :key="workflow.id"
          type="button"
          class="focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
          :class="
            selectedId === workflow.id
              ? 'border-primary bg-primary/5'
              : 'hover:border-border hover:bg-muted/40 border-transparent'
          "
          @click="selectedId = workflow.id"
        >
          <span class="flex items-center gap-1.5">
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ workflow.name }}</span>
            <span
              v-if="!workflow.enabled"
              class="text-muted-foreground bg-muted shrink-0 rounded px-1 text-[10px]"
              >off</span
            >
          </span>
          <span class="text-muted-foreground mt-0.5 block text-[11px]">
            {{ workflow.graph.steps.length }} step{{ workflow.graph.steps.length === 1 ? '' : 's' }}
            <template v-if="workflow.trigger.autoStart"> · auto</template>
          </span>
        </button>
      </aside>

      <section v-if="!draft" class="text-muted-foreground grid place-items-center rounded-lg border py-16 text-sm">
        Choose a workflow to edit
      </section>

      <!-- ------------------------------------------------------ definitions -->
      <section v-else-if="tab === 'definitions'" class="min-w-0 space-y-4">
        <div class="grid gap-3 sm:grid-cols-2">
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">Name</span>
            <Input v-model="draft.name" :disabled="!canManage" />
          </label>
          <label class="flex items-end gap-2 pb-2">
            <Checkbox v-model="draft.enabled" :disabled="!canManage" />
            <span class="text-xs">Available to run</span>
          </label>
        </div>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Description</span>
          <Textarea v-model="draft.description" :disabled="!canManage" rows="2" />
        </label>

        <ul v-if="graphIssues.length" class="space-y-1 text-xs">
          <li
            v-for="(issue, i) in graphIssues"
            :key="i"
            :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
          >
            {{ issue.message }}
          </li>
        </ul>

        <div class="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
          <WorkflowGraphEditor
            v-model:selected-id="selectedStepId"
            :graph="draft.graph"
            :issues="issues"
            :can-manage="canManage"
            @update:graph="(g) => (draft!.graph = g)"
          />
          <div class="rounded-lg border p-4">
            <WorkflowStepForm
              v-if="step"
              :step="step"
              :graph="draft.graph"
              :issues="issues"
              :can-manage="canManage"
              @update="updateStep"
              @remove="removeStep"
            />
            <p v-else class="text-muted-foreground py-8 text-center text-sm">
              Select a step on the canvas to configure it.
            </p>
          </div>
        </div>
      </section>

      <!-- --------------------------------------------------------- triggers -->
      <section v-else class="min-w-0 max-w-xl space-y-5">
        <label class="flex items-start gap-2">
          <Checkbox
            :model-value="draft.trigger.manual"
            :disabled="!canManage"
            @update:model-value="(v) => (draft!.trigger = { ...draft!.trigger, manual: Boolean(v) })"
          />
          <span>
            <span class="block text-sm font-medium">Offer a Run button on pages</span>
            <span class="text-muted-foreground block text-xs">Started by hand from a page or from /workflows.</span>
          </span>
        </label>

        <label class="flex items-start gap-2">
          <Checkbox
            :model-value="draft.trigger.autoStart"
            :disabled="!canManage"
            @update:model-value="(v) => (draft!.trigger = { ...draft!.trigger, autoStart: Boolean(v) })"
          />
          <span>
            <span class="block text-sm font-medium">Start automatically</span>
            <span class="text-muted-foreground block text-xs">
              Fires on the events below. A page that already has a run of this workflow is never started again,
              and a workspace is capped on how many triggered runs it can have in flight — without those, one
              busy page turns into a great many model calls.
            </span>
          </span>
        </label>

        <div v-if="draft.trigger.autoStart" class="space-y-4 border-l-2 pl-3">
          <div class="space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">On these events</span>
            <label v-for="event in TRIGGER_EVENTS" :key="event" class="flex items-center gap-2">
              <Checkbox
                :model-value="draft.trigger.events.includes(event)"
                :disabled="!canManage"
                @update:model-value="(v) => toggleTriggerEvent(event, Boolean(v))"
              />
              <span class="font-mono text-xs">{{ event }}</span>
            </label>
          </div>

          <div class="space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">Only for pages in these categories</span>
            <p class="text-muted-foreground text-[11px]">None selected means every category.</p>
            <div class="flex flex-wrap gap-x-4 gap-y-1.5">
              <label v-for="c in DOCUMENT_CATEGORIES" :key="c" class="flex items-center gap-1.5">
                <Checkbox
                  :model-value="draft.trigger.categories.includes(c)"
                  :disabled="!canManage"
                  @update:model-value="(v) => toggleTriggerCategory(c, Boolean(v))"
                />
                <span class="text-xs">{{ c }}</span>
              </label>
            </div>
          </div>
        </div>
      </section>
    </div>

    <div
      v-if="draft && canManage"
      class="bg-background/85 sticky bottom-0 -mx-4 -mb-6 mt-2 flex flex-wrap items-center gap-3 border-t px-4 py-3 backdrop-blur lg:-mx-8 lg:px-8"
    >
      <Button size="sm" :disabled="!dirty || saving || errors.length > 0" @click="save">
        {{ saving ? 'Saving…' : 'Save' }}
      </Button>
      <Button size="sm" variant="outline" :disabled="!dirty" @click="discard">Discard</Button>
      <Button size="sm" variant="ghost" @click="validateOnServer">Check on server</Button>
      <span v-if="errors.length" class="text-destructive text-xs">
        {{ errors.length }} problem{{ errors.length === 1 ? '' : 's' }} to fix
      </span>
      <span v-else-if="dirty" class="text-muted-foreground text-xs">Unsaved changes</span>
      <Button
        v-if="selected"
        size="sm"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive ml-auto"
        @click="remove(selected)"
      >
        Delete
      </Button>
    </div>
  </div>
</template>
