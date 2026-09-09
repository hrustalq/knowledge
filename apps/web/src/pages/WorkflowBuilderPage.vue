<script setup lang="ts">
/**
 * The workflow builder: one workflow, the whole viewport (docs/features/17).
 *
 * The canvas used to live in a 19rem column inside the settings shell, beside a
 * roster and under a page header — which is why it read as a diagram attached
 * to a form rather than as the thing being edited. Here the chain is the page:
 * a palette of the four steps on the left, the canvas in the middle, the
 * selected step's behaviour on the right, and what is wrong with the graph
 * along the bottom.
 *
 * Deliberately not a child route of `/settings`: it keeps the settings URL so
 * every link still reads as workspace administration, but rendering inside that
 * shell would put a second navigation rail beside the palette and box the
 * canvas again. `meta.fill` gives it the viewport; `meta.bare` drops the app
 * trail, because the header here already says where you are and offers the way
 * back.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import {
  ArrowLeft,
  Check,
  CircleAlert,
  MoreHorizontal,
  PanelRight,
  Play,
  Trash2,
  TriangleAlert,
  Undo2,
} from 'lucide-vue-next'
import type {
  ValidateWorkflowResponse,
  WorkflowDefinitionInfo,
  WorkflowGraph,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
  WorkflowValidationIssue,
} from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { api } from '@/api/client'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Button, buttonVariants } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
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
import WorkflowGraphEditor from '@/components/workflows/WorkflowGraphEditor.vue'
import WorkflowStepForm from '@/components/workflows/WorkflowStepForm.vue'
import WorkflowStepPalette from '@/components/workflows/WorkflowStepPalette.vue'
import WorkflowSettingsForm from '@/components/workflows/WorkflowSettingsForm.vue'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const store = useWorkflowsStore()

const id = computed(() => String(route.params.id))
const canManage = computed(() => auth.canAdminWorkspace)

const query = useQuery(computed(() => apiQueryOptions('/v1/workflows/{id}', { path: { id: id.value } })))
const workflow = computed(() => query.data.value as WorkflowDefinitionInfo | undefined)

/**
 * The canvas fires on every drag, so the draft is local and the server sees one
 * write when you save. A round trip per frame would be both slow and
 * unreviewable.
 *
 * JSON round trip, not `structuredClone`: the query cache hands back a Vue
 * reactive Proxy and `structuredClone` throws `DataCloneError` on a proxy. The
 * graph is plain JSON by construction, so both are safe and it is exactly what
 * `dirty` compares against.
 */
const detach = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

interface Draft {
  name: string
  description: string
  graph: WorkflowGraph
  trigger: WorkflowTrigger
  enabled: boolean
}

const draftOf = (w: WorkflowDefinitionInfo): Draft => ({
  name: w.name,
  description: w.description ?? '',
  graph: detach(w.graph),
  trigger: detach(w.trigger),
  enabled: w.enabled,
})

const draft = ref<Draft | null>(null)
const selectedStepId = ref<string | null>(null)
const inspectorOpen = ref(false)
const canvas = ref<InstanceType<typeof WorkflowGraphEditor> | null>(null)

watch(
  workflow,
  (w) => {
    if (!w) return
    // Only re-seed from the server when there is nothing local to lose: a live
    // refetch must not throw away a canvas someone is halfway through arranging.
    if (!draft.value || !dirty.value) draft.value = draftOf(w)
  },
  { immediate: true },
)

const dirty = computed(() => {
  if (!workflow.value || !draft.value) return false
  return JSON.stringify(draftOf(workflow.value)) !== JSON.stringify(draft.value)
})

/**
 * Validation runs locally against the compiler the API will run. That is the
 * whole reason the machines live in a shared package: the canvas can say "this
 * graph has a cycle" the instant you draw one, and be right.
 */
const issues = computed<WorkflowValidationIssue[]>(() => (draft.value ? validateGraph(draft.value.graph) : []))
const errors = computed(() => issues.value.filter((i) => i.severity === 'error'))
const warnings = computed(() => issues.value.filter((i) => i.severity === 'warning'))
const step = computed(() => draft.value?.graph.steps.find((s) => s.id === selectedStepId.value) ?? null)

function updateStep(next: WorkflowStep) {
  if (!draft.value) return
  draft.value.graph = {
    ...draft.value.graph,
    steps: draft.value.graph.steps.map((s) => (s.id === next.id ? next : s)),
  }
}

function removeStep(stepId: string) {
  if (!draft.value) return
  const layout = { ...(draft.value.graph.layout ?? {}) }
  delete layout[stepId]
  draft.value.graph = {
    // Edges into a deleted step go with it, or the graph keeps a dangling
    // reference the compiler would reject on save.
    steps: draft.value.graph.steps
      .filter((s) => s.id !== stepId)
      .map((s) => ({ ...s, next: s.next.filter((n) => n !== stepId) })),
    layout,
  }
  selectedStepId.value = null
}

/* --------------------------------------------------------------- mutations */

const invalidates = () => [['/v1/workflows']]
const updateWorkflow = useApiMutation('patch', '/v1/workflows/{id}', { invalidates })
const deleteWorkflow = useApiMutation('delete', '/v1/workflows/{id}', { invalidates })

const saving = ref(false)

async function save() {
  if (!workflow.value || !draft.value || !dirty.value) return
  if (errors.value.length) {
    toast.error(t('workflow.fixProblems'))
    return
  }
  saving.value = true
  try {
    await updateWorkflow.mutateAsync({
      path: { id: id.value },
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

function discard() {
  if (!workflow.value) return
  draft.value = draftOf(workflow.value)
  selectedStepId.value = null
}

const confirmingDelete = ref(false)

async function remove() {
  try {
    await deleteWorkflow.mutateAsync({ path: { id: id.value } })
    await store.refresh()
    confirmingDelete.value = false
    toast.success(t('workflow.deleted'))
    void router.push('/settings/workflows')
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
  if (!draft.value) return
  try {
    const res = (await api.post('/v1/workflows/{id}/validate', {
      path: { id: id.value },
      body: { graph: draft.value.graph },
    })) as ValidateWorkflowResponse
    if (res.valid) toast.success(t('workflow.builder.serverAccepts'))
    else toast.error(res.issues.map((i) => i.message).join(' '))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/* --------------------------------------------------------------- keyboard */

function onKeydown(event: KeyboardEvent) {
  const target = event.target as HTMLElement | null
  const typing = !!target?.closest('input, textarea, [contenteditable="true"]')
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    event.preventDefault()
    void save()
    return
  }
  if (typing || !canManage.value) return
  if ((event.key === 'Backspace' || event.key === 'Delete') && selectedStepId.value) {
    event.preventDefault()
    removeStep(selectedStepId.value)
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// Leaving with unsaved canvas work is the one loss this page can cause that no
// amount of undo recovers, because the arrangement was never sent anywhere.
onBeforeRouteLeave(() => {
  if (!dirty.value) return true
  return window.confirm(t('workflow.builder.leaveUnsaved'))
})

function addStep(kind: WorkflowStepKind) {
  canvas.value?.addStep(kind)
}

// On a narrow screen the inspector is a sheet, so selecting a step has to open
// it — otherwise the step is selected and its settings are nowhere.
watch(selectedStepId, (value) => {
  if (value && typeof window !== 'undefined' && !window.matchMedia('(min-width: 1024px)').matches) {
    inspectorOpen.value = true
  }
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Header: where you are, what state it is in, and the two verbs. -->
    <header class="flex h-14 shrink-0 items-center gap-2 border-b px-3 lg:px-4">
      <RouterLink to="/settings/workflows">
        <Button variant="ghost" size="sm" class="gap-1.5 px-2">
          <ArrowLeft class="size-4" />
          <span class="hidden sm:inline">{{ t('nav.workflows') }}</span>
        </Button>
      </RouterLink>
      <span class="bg-border h-5 w-px" aria-hidden="true" />

      <template v-if="draft">
        <Input
          v-model="draft.name"
          :disabled="!canManage"
          :aria-label="t('workflow.name')"
          class="focus-visible:border-input h-8 min-w-0 max-w-64 border-transparent bg-transparent px-1 text-[15px] font-semibold shadow-none focus-visible:px-2"
        />

        <label class="text-muted-foreground hidden items-center gap-1.5 text-xs sm:flex">
          <Checkbox v-model="draft.enabled" :disabled="!canManage" />
          {{ t('workflow.settings.availableToRun') }}
        </label>

        <!-- Validity, always visible, never a toast you can miss. -->
        <p v-if="errors.length" class="text-destructive ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          <CircleAlert class="size-3.5" />
          <span class="hidden sm:inline">{{ t('count.problems', { n: errors.length }, errors.length) }}</span>
        </p>
        <p v-else-if="dirty" class="text-muted-foreground ml-auto shrink-0 text-xs">{{ t('workflow.unsaved') }}</p>
        <p v-else class="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-xs">
          <Check class="size-3.5" /> <span class="hidden sm:inline">{{ t('workflow.settings.saved') }}</span>
        </p>

        <div class="flex shrink-0 items-center gap-1.5">
          <Button
            v-if="dirty"
            variant="ghost"
            size="sm"
            class="hidden sm:inline-flex"
            @click="discard"
          >
            {{ t('common.discard') }}
          </Button>
          <Button
            v-if="canManage"
            size="sm"
            :disabled="!dirty || saving || errors.length > 0"
            @click="save"
          >
            {{ saving ? t('workflow.settings.saving') : t('common.save') }}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            class="size-8 p-0 xl:hidden"
            :aria-label="t('workflow.builder.openInspector')"
            @click="inspectorOpen = true"
          >
            <PanelRight class="size-4" />
          </Button>

          <!-- Deleting the workflow belongs here rather than in the inspector:
               that panel is replaced by the step form the moment a step is
               selected, and it does not exist at all below xl — so delete kept
               disappearing depending on what you had clicked and how wide the
               window was. -->
          <DropdownMenu v-if="canManage">
            <DropdownMenuTrigger as-child>
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground size-8 p-0"
                :aria-label="t('workflow.builder.moreActions')"
              >
                <MoreHorizontal class="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="w-52">
              <DropdownMenuItem @select="validateOnServer">
                <Check class="size-3.5" />
                {{ t('workflow.settings.checkOnServer') }}
              </DropdownMenuItem>
              <DropdownMenuItem v-if="dirty" @select="discard">
                <Undo2 class="size-3.5" />
                {{ t('common.discard') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" @select="confirmingDelete = true">
                <Trash2 class="size-3.5" />
                {{ t('workflow.settings.deleteWorkflow') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </template>
    </header>

    <div v-if="query.isLoading.value" class="flex min-h-0 flex-1 gap-3 p-3">
      <Skeleton class="hidden h-full w-56 lg:block" />
      <Skeleton class="h-full flex-1" />
    </div>

    <div v-else-if="draft" class="flex min-h-0 flex-1">
      <!-- Palette. The whole vocabulary, always visible: four kinds is a list
           you can learn, not a menu you have to search. -->
      <aside class="hidden w-56 shrink-0 border-r lg:flex lg:flex-col">
        <WorkflowStepPalette :can-manage="canManage" @add="addStep" />
      </aside>

      <div class="flex min-w-0 flex-1 flex-col">
        <!-- Below lg the palette is a strip: the same four, one row, still
             reachable without a menu. -->
        <div class="shrink-0 border-b px-2 py-1.5 lg:hidden">
          <WorkflowStepPalette orientation="strip" :can-manage="canManage" @add="addStep" />
        </div>

        <WorkflowGraphEditor
          ref="canvas"
          v-model:selected-id="selectedStepId"
          :graph="draft.graph"
          :issues="issues"
          :can-manage="canManage"
          @update:graph="(g) => (draft!.graph = g)"
        />

        <!-- Problems, along the bottom where a builder puts them. Each row is a
             shortcut into the step it is about, so a message is never a hunt. -->
        <footer
          v-if="issues.length"
          class="max-h-28 shrink-0 space-y-1 overflow-y-auto border-t px-3 py-2"
        >
          <button
            v-for="(issue, i) in [...errors, ...warnings]"
            :key="i"
            type="button"
            class="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left text-xs focus-visible:ring-2 focus-visible:outline-none"
            :disabled="!issue.stepId"
            @click="issue.stepId && (selectedStepId = issue.stepId)"
          >
            <component
              :is="issue.severity === 'error' ? CircleAlert : TriangleAlert"
              class="mt-px size-3.5 shrink-0"
              :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
            />
            <span class="min-w-0 flex-1 leading-snug">{{ issue.message }}</span>
          </button>
        </footer>
      </div>

      <!-- Inspector: the step if one is selected, the workflow otherwise. -->
      <aside class="hidden w-80 shrink-0 flex-col overflow-hidden border-l xl:flex">
        <WorkflowStepForm
          v-if="step"
          :step="step"
          :graph="draft.graph"
          :issues="issues"
          :can-manage="canManage"
          @update="updateStep"
          @remove="removeStep"
          @select="(sid) => (selectedStepId = sid)"
        />
        <WorkflowSettingsForm
          v-else
          v-model:description="draft.description"
          v-model:trigger="draft.trigger"
          :can-manage="canManage"
        >
          <template #footer>
            <div class="space-y-0.5 border-t pt-3">
              <RouterLink v-if="workflow?.enabled" to="/workflows" class="block">
                <Button variant="ghost" size="sm" class="text-muted-foreground w-full justify-start">
                  <Play class="mr-1.5 size-3.5" /> {{ t('workflow.builder.seeRuns') }}
                </Button>
              </RouterLink>
            </div>
          </template>
        </WorkflowSettingsForm>
      </aside>
    </div>

    <!-- Narrow screens: the same inspector, as a sheet. -->
    <Sheet v-model:open="inspectorOpen">
      <SheetContent side="right" class="w-full max-w-sm overflow-y-auto p-0">
        <SheetHeader class="sr-only">
          <SheetTitle>{{ t('workflow.builder.openInspector') }}</SheetTitle>
        </SheetHeader>
        <WorkflowStepForm
          v-if="draft && step"
          :step="step"
          :graph="draft.graph"
          :issues="issues"
          :can-manage="canManage"
          @update="updateStep"
          @remove="removeStep"
          @select="(sid) => (selectedStepId = sid)"
        />
        <WorkflowSettingsForm
          v-else-if="draft"
          v-model:description="draft.description"
          v-model:trigger="draft.trigger"
          :can-manage="canManage"
        />
      </SheetContent>
    </Sheet>

    <AlertDialog v-model:open="confirmingDelete">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{{ t('workflow.builder.deleteTitle', { name: draft?.name ?? '' }) }}</AlertDialogTitle>
          <AlertDialogDescription>{{ t('workflow.builder.deleteBody') }}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{{ t('common.cancel') }}</AlertDialogCancel>
          <AlertDialogAction :class="buttonVariants({ variant: 'destructive' })" @click="remove">
            {{ t('workflow.settings.deleteWorkflow') }}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
