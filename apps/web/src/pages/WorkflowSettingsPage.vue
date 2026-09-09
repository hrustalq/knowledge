<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, CircleAlert, Plus, Workflow, Zap } from 'lucide-vue-next'
import type {
  ListWorkflowsResponse,
  ValidateWorkflowResponse,
  WorkflowDefinitionInfo,
  WorkflowGraph,
  WorkflowStep,
  WorkflowTrigger,
  WorkflowValidationIssue,
} from '@knowledge/contracts'
import { DOCUMENT_CATEGORIES, KNOWN_EVENT_TYPES } from '@knowledge/contracts'
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

const { t } = useI18n()

/**
 * The workflow workbench (docs/features/17).
 *
 * Three panes, not a form: the roster picks the workflow, the canvas *is* the
 * workflow, and the inspector edits whatever is selected — a step if one is,
 * the workflow itself otherwise. The previous version buried the graph under a
 * name field, a description field and a tab bar, which put the only part anyone
 * came here to see below the fold.
 *
 * Triggers used to be a second tab. They are a property of the workflow, so
 * they belong in the workflow inspector; splitting one object across two tabs
 * is what made a three-field decision feel like configuration.
 *
 * Gated in the page on `auth.canAdminWorkspace` rather than by a router meta
 * flag, exactly as AI settings is: this is workspace administration.
 */
const auth = useAuthStore()
const store = useWorkflowsStore()
const workspaceId = getWorkspaceId()

const canManage = computed(() => auth.canAdminWorkspace)

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

/**
 * A JSON round trip, not `structuredClone`: the query cache hands back a Vue
 * reactive Proxy, and `structuredClone` throws `DataCloneError` on a proxy.
 * The graph is plain JSON by construction, so this is both safe and exactly
 * what `dirty` compares against.
 */
const detach = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function draftOf(workflow: WorkflowDefinitionInfo) {
  return {
    name: workflow.name,
    description: workflow.description ?? '',
    graph: detach(workflow.graph),
    trigger: detach(workflow.trigger),
    enabled: workflow.enabled,
  }
}

watch(selected, (workflow) => {
  draft.value = workflow ? draftOf(workflow) : null
  selectedStepId.value = null
})

// Open the first workflow rather than leaving an empty right pane: there is
// only ever a handful, and an editor with nothing in it teaches nothing.
watch(
  workflows,
  (list) => {
    if (!selectedId.value && list.length) selectedId.value = list[0].id
  },
  { immediate: true },
)

const dirty = computed(() => {
  if (!selected.value || !draft.value) return false
  return JSON.stringify(draftOf(selected.value)) !== JSON.stringify(draft.value)
})

/**
 * Validation runs locally, against the very compiler the API will run. That is
 * the whole reason the machines live in a shared package: the editor can say
 * "this graph has a cycle" the instant you draw it, and be right.
 */
const issues = computed<WorkflowValidationIssue[]>(() => (draft.value ? validateGraph(draft.value.graph) : []))
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

/**
 * A new workflow arrives with a working first step rather than an empty canvas.
 * The blank state of a graph editor teaches nothing, and this step is the shape
 * every chain in this product starts from.
 */
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
              prompt: { user: 'List the use cases this entity takes part in.' },
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
    toast.error(t('workflow.fixProblems'))
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
    toast.success(t('workflow.saved'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

/** Re-seed the local draft from the stored row, throwing away canvas edits. */
function discard() {
  if (!selected.value) return
  draft.value = draftOf(selected.value)
  selectedStepId.value = null
}

async function remove(workflow: WorkflowDefinitionInfo) {
  if (!confirm(`Delete "${workflow.name}"? Its finished runs go with it.`)) return
  try {
    await deleteWorkflow.mutateAsync({ path: { id: workflow.id } })
    await query.refetch()
    await store.refresh()
    if (selectedId.value === workflow.id) selectedId.value = null
    toast.success(t('workflow.deleted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/**
 * A second opinion from the server. The local compiler is the same code, so
 * this really checks that the definition the server *stored* still compiles —
 * worth having after someone else edited it in another window.
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

const TRIGGER_EVENTS = KNOWN_EVENT_TYPES.filter((e) => e.startsWith('document.') || e.startsWith('revision.'))

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

/** The one-line summary a roster row carries, so the list stays scannable. */
function summarize(workflow: WorkflowDefinitionInfo): string {
  const n = workflow.graph.steps.length
  return t('count.steps', { n }, n)
}
</script>

<template>
  <div class="flex min-h-0 w-full flex-1 flex-col gap-4">
    <header class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="text-lg font-semibold">{{ t('nav.workflows') }}</h1>
        <p class="text-muted-foreground mt-1 max-w-2xl text-sm">
          A chain that turns one page into the next level of detail — an entity into use cases, a use case into
          endpoints and screens. Nothing is published until someone approves it.
        </p>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="!canManage" variant="outline">{{ t('workflow.readOnlyAdmin') }}</Badge>
        <Button v-if="canManage" size="sm" @click="createNew">
          <Plus class="mr-1.5 size-4" /> New workflow
        </Button>
      </div>
    </header>

    <div v-if="query.isLoading.value" class="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)]">
      <div class="space-y-2">
        <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
      </div>
      <Skeleton class="h-[26rem] w-full" />
    </div>

    <!-- The empty state teaches the model rather than announcing absence. -->
    <div
      v-else-if="workflows.length === 0"
      class="flex flex-1 flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center"
    >
      <Workflow class="text-muted-foreground/40 size-8" />
      <div class="max-w-md">
        <p class="text-sm font-medium">{{ t('workflow.noWorkflows') }}</p>
        <p class="text-muted-foreground mt-1.5 text-sm leading-relaxed">
          A workflow is a chain of steps. The one this product was built for is three links long: an entity page
          breaks down into use cases, and each use case becomes a set of API endpoints and screens.
        </p>
      </div>
      <Button v-if="canManage" size="sm" @click="createNew">
        <Plus class="mr-1.5 size-4" /> Create the first one
      </Button>
    </div>

    <div
      v-else
      class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[14rem_minmax(0,1fr)]"
    >
      <!-- Roster -->
      <aside class="min-h-0 space-y-1 overflow-auto lg:pr-1">
        <button
          v-for="workflow in workflows"
          :key="workflow.id"
          type="button"
          class="focus-visible:ring-ring w-full rounded-md border px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
          :class="
            selectedId === workflow.id ? 'border-primary/40 bg-primary/5' : 'hover:bg-muted/40 border-transparent'
          "
          @click="selectedId = workflow.id"
        >
          <span class="flex items-center gap-1.5">
            <!-- Status is a dot, not a banner. -->
            <span
              class="size-1.5 shrink-0 rounded-full"
              :class="workflow.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/30'"
              :title="workflow.enabled ? 'Available to run' : 'Not available'"
            />
            <span class="min-w-0 flex-1 truncate text-sm font-medium">{{ workflow.name }}</span>
            <Zap
              v-if="workflow.trigger.autoStart"
              class="text-muted-foreground size-3 shrink-0"
              :title="t('workflow.startsOnItsOwn')"
            />
          </span>
          <span class="text-muted-foreground mt-0.5 block pl-3 text-[11px]">{{ summarize(workflow) }}</span>
        </button>
      </aside>

      <!-- Workbench -->
      <section v-if="draft" class="flex min-h-0 flex-col gap-3">
        <!-- The name is the title of what you are looking at, edited in place.
             A labelled field above the canvas made the canvas an afterthought. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Input
            v-model="draft.name"
            :disabled="!canManage"
            :aria-label="t('workflow.name')"
            class="focus-visible:border-input h-auto max-w-sm border-transparent bg-transparent px-0 text-base font-semibold shadow-none focus-visible:px-2"
          />
          <label class="text-muted-foreground flex items-center gap-1.5 text-xs">
            <Checkbox v-model="draft.enabled" :disabled="!canManage" />
            Available to run
          </label>
          <p v-if="errors.length" class="text-destructive ml-auto flex items-center gap-1.5 text-xs">
            <CircleAlert class="size-3.5" />
            {{ t('count.problems', { n: errors.length }, errors.length) }}
          </p>
          <p v-else-if="dirty" class="text-muted-foreground ml-auto text-xs">{{ t('workflow.unsaved') }}</p>
          <p v-else class="text-muted-foreground ml-auto flex items-center gap-1.5 text-xs">
            <Check class="size-3.5" /> Saved
          </p>
        </div>

        <p
          v-for="(issue, i) in graphIssues"
          :key="i"
          class="text-xs"
          :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
        >
          {{ issue.message }}
        </p>

        <div class="grid min-h-0 gap-3 lg:h-[calc(100dvh_-_20.5rem)] lg:min-h-[24rem] xl:grid-cols-[minmax(0,1fr)_19rem]">
          <WorkflowGraphEditor
            v-model:selected-id="selectedStepId"
            :graph="draft.graph"
            :issues="issues"
            :can-manage="canManage"
            class="min-h-[24rem]"
            @update:graph="(g) => (draft!.graph = g)"
          />

          <!-- Inspector: the step if one is selected, the workflow otherwise. -->
          <div class="flex min-h-0 flex-col overflow-hidden rounded-lg border">
            <WorkflowStepForm
              v-if="step"
              :step="step"
              :graph="draft.graph"
              :issues="issues"
              :can-manage="canManage"
              @update="updateStep"
              @remove="removeStep"
              @select="(id) => (selectedStepId = id)"
            />

            <template v-else>
              <header class="border-b px-4 py-3">
                <p class="text-sm font-medium">{{ t('workflow.thisWorkflow') }}</p>
                <p class="text-muted-foreground text-[11px]">{{ t('workflow.selectStep') }}</p>
              </header>
              <div class="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
                <label class="block space-y-1.5">
                  <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.description') }}</span>
                  <Textarea
                    v-model="draft.description"
                    :disabled="!canManage"
                    rows="3"
                    :placeholder="t('workflow.descriptionPlaceholder')"
                  />
                </label>

                <div class="space-y-2">
                  <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.starts') }}</span>
                  <label class="flex items-start gap-2">
                    <Checkbox
                      :model-value="draft.trigger.manual"
                      :disabled="!canManage"
                      @update:model-value="(v) => (draft!.trigger = { ...draft!.trigger, manual: Boolean(v) })"
                    />
                    <span class="min-w-0">
                      <span class="block text-xs font-medium">{{ t('workflow.whenSomeoneAsks') }}</span>
                      <span class="text-muted-foreground block text-[11px] leading-snug">
                        A Run button on the page, and on /workflows.
                      </span>
                    </span>
                  </label>
                  <label class="flex items-start gap-2">
                    <Checkbox
                      :model-value="draft.trigger.autoStart"
                      :disabled="!canManage"
                      @update:model-value="(v) => (draft!.trigger = { ...draft!.trigger, autoStart: Boolean(v) })"
                    />
                    <span class="min-w-0">
                      <span class="block text-xs font-medium">{{ t('workflow.onItsOwn') }}</span>
                      <span class="text-muted-foreground block text-[11px] leading-snug">
                        Fires on the events below. A page that already has a run is never started again, and a
                        workspace is capped on how many can run at once.
                      </span>
                    </span>
                  </label>
                </div>

                <div v-if="draft.trigger.autoStart" class="space-y-4">
                  <div class="space-y-1.5">
                    <span class="text-muted-foreground text-xs font-medium">After</span>
                    <label v-for="event in TRIGGER_EVENTS" :key="event" class="flex items-center gap-2">
                      <Checkbox
                        :model-value="draft.trigger.events.includes(event)"
                        :disabled="!canManage"
                        @update:model-value="(v) => toggleTriggerEvent(event, Boolean(v))"
                      />
                      <span class="font-mono text-[11px]">{{ event }}</span>
                    </label>
                  </div>
                  <div class="space-y-1.5">
                    <span class="text-muted-foreground text-xs font-medium">Only for</span>
                    <div class="flex flex-wrap gap-x-3 gap-y-1.5">
                      <label v-for="c in DOCUMENT_CATEGORIES" :key="c" class="flex items-center gap-1.5">
                        <Checkbox
                          :model-value="draft.trigger.categories.includes(c)"
                          :disabled="!canManage"
                          @update:model-value="(v) => toggleTriggerCategory(c, Boolean(v))"
                        />
                        <span class="text-[11px]">{{ t(`category.${c}`) }}</span>
                      </label>
                    </div>
                    <p class="text-muted-foreground text-[11px]">Nothing ticked means every category.</p>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <footer v-if="canManage" class="flex flex-wrap items-center gap-2 border-t pt-3">
          <Button size="sm" :disabled="!dirty || saving || errors.length > 0" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </Button>
          <Button size="sm" variant="ghost" :disabled="!dirty" @click="discard">Discard</Button>
          <Button size="sm" variant="ghost" class="text-muted-foreground" @click="validateOnServer">
            Check on server
          </Button>
          <Button
            v-if="selected"
            size="sm"
            variant="ghost"
            class="text-muted-foreground hover:text-destructive ml-auto"
            @click="remove(selected)"
          >
            Delete workflow
          </Button>
        </footer>
      </section>
    </div>
  </div>
</template>
