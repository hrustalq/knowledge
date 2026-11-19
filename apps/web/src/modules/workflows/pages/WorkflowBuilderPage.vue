<script setup lang="ts">
/**
 * One workflow, beside the roster it was picked from (docs/features/17).
 *
 * This is the third pane of the settings shell — the position
 * `/settings/projects/:id` holds — so the chain arrives the way every other
 * page in this product does: with the app trail above it saying where it sits,
 * and the list it came from still on screen. It spent a release as a
 * full-viewport surface with a back arrow and a toolbar of its own, which is
 * the shape an editor takes when it cannot afford the chrome; a canvas is not
 * a writing surface, and the trail it dropped was the only thing telling you
 * this was workspace administration rather than somewhere you had navigated to.
 *
 * What made the viewport necessary was the column count: a palette rail, the
 * canvas, and an inspector rail, which left nothing for the canvas once a
 * settings nav and a roster stood to their left. Since #1246 neither rail
 * exists: the palette is a toolbar floating on the canvas beside undo, redo,
 * export and import; a step's choices are a popover on the step itself; and the
 * drawer is left with the long fields (a step's prompt, or the workflow's
 * description and triggers behind Configure). The canvas keeps the whole pane.
 *
 * Reading a chain is `/settings/workflows/:id`, a different page; this route is
 * only reached by pressing Edit. That split is what lets the canvas keep a
 * dirty draft and an unsaved-changes guard without arming a confirm dialog
 * every time somebody glances at a workflow.
 *
 * The architect sits beside the canvas rather than only at creation. It is the
 * wizard's own conversation — `POST /v1/workflows/draft`, the `architect`
 * agent, compiled server-side before it answers — given the draft graph as
 * context, so a follow-up is "make it three steps" rather than a description of
 * the chain from scratch. What it returns lands on the canvas as an unsaved
 * edit: the operator reviews and saves, the same as any other change made here.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import {
  Check,
  CircleAlert,
  Download,
  MoreHorizontal,
  PanelRight,
  Play,
  Redo2,
  Sparkles,
  Trash2,
  TriangleAlert,
  Undo2,
  Upload,
  X,
} from 'lucide-vue-next'
import type {
  WorkflowDefinitionInfo,
  WorkflowGraph,
  WorkflowStep,
  WorkflowStepKind,
  WorkflowTrigger,
  WorkflowValidationIssue,
} from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { api } from '@/shared/api/client'
import { saveFile } from '@/shared/api/api'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { usePermission } from '@/stores/permissions'
import { useWorkflowsStore } from '@/entities/workflow'
import { Button, buttonVariants } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { Checkbox } from '@knowledge/ui/checkbox'
import { Input } from '@knowledge/ui/input'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@knowledge/ui/sheet'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@knowledge/ui/dropdown-menu'
import { Skeleton } from '@knowledge/ui/skeleton'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@knowledge/ui/alert-dialog'
import WorkflowCanvas from '@/modules/workflows/components/WorkflowCanvas.vue'
import WorkflowStepForm from '@/modules/workflows/components/WorkflowStepForm.vue'
import WorkflowStepQuickEdit from '@/modules/workflows/components/WorkflowStepQuickEdit.vue'
import WorkflowStepPalette from '@/modules/workflows/components/WorkflowStepPalette.vue'
import WorkflowSettingsForm from '@/modules/workflows/components/WorkflowSettingsForm.vue'
import WorkflowArchitectChat from '@/modules/workflows/components/WorkflowArchitectChat.vue'
import type { WizardTurn } from '@/modules/workflows/model/wizard-machine'
import { graphHistory } from '@/modules/workflows/model/graph-history'
import { graphFileName, graphToJson, parseGraphJson } from '@/modules/workflows/model/workflow-json'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useWorkflowsStore()

const id = computed(() => String(route.params.id))
const canManage = usePermission('workspace:admin')

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
/** What the drawer holds: a step's long fields, or the workflow's settings. */
const drawer = ref<'step' | 'settings' | null>(null)
const canvas = ref<InstanceType<typeof WorkflowCanvas> | null>(null)

/**
 * Every change to the graph goes through here, so undo covers all of them —
 * the canvas, the popover, the drawer, an import and the architect alike.
 * The name, description and triggers are form fields with their own native
 * undo, and stay out of it.
 */
const history = graphHistory(
  () => draft.value?.graph,
  (graph) => {
    if (draft.value) draft.value.graph = graph
  },
)
const setGraph = (graph: WorkflowGraph, key?: string) => history.apply(graph, key)

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

function updateStep(next: WorkflowStep, key?: string) {
  if (!draft.value) return
  setGraph(
    { ...draft.value.graph, steps: draft.value.graph.steps.map((s) => (s.id === next.id ? next : s)) },
    key,
  )
}

function removeStep(stepId: string) {
  if (!draft.value) return
  const layout = { ...(draft.value.graph.layout ?? {}) }
  delete layout[stepId]
  setGraph({
    // Edges into a deleted step go with it, or the graph keeps a dangling
    // reference the compiler would reject on save.
    steps: draft.value.graph.steps
      .filter((s) => s.id !== stepId)
      .map((s) => ({ ...s, next: s.next.filter((n) => n !== stepId) })),
    layout,
  })
  selectedStepId.value = null
  if (drawer.value === 'step') drawer.value = null
}

/* ------------------------------------------------------------ JSON file */

function exportGraph() {
  if (!draft.value) return
  saveFile(new Blob([graphToJson(draft.value.graph)], { type: 'application/json' }), graphFileName(draft.value.name))
}

const fileInput = ref<HTMLInputElement | null>(null)

/**
 * An import replaces the graph as one undoable, unsaved edit — the same
 * footing as an architect proposal. A file that is not a graph is refused; one
 * that is a graph with problems lands, and the problems list says what to fix.
 */
async function importGraph(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !draft.value) return
  const parsed = parseGraphJson(await file.text())
  if (!parsed.ok) {
    toast.error(t(parsed.reason === 'json' ? 'workflow.file.notJson' : 'workflow.file.notGraph'))
    return
  }
  setGraph(parsed.graph)
  selectedStepId.value = null
  canvas.value?.refit()
  const problems = parsed.issues.filter((i) => i.severity === 'error').length
  if (problems) toast.warning(t('workflow.file.importedWithProblems', { n: problems }, problems))
  else toast.success(t('workflow.file.imported'))
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
  // Discard is the decision to drop every edit; undoing past it would bring
  // back edits the stack no longer has a starting point for.
  history.reset()
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
    const res = await api.post('/v1/workflows/{id}/validate', {
      path: { id: id.value },
      body: { graph: draft.value.graph },
    })
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
  // A text field keeps its own undo; outside one, the keys undo the graph.
  if (typing || !canManage.value) return
  const key = event.key.toLowerCase()
  if ((event.metaKey || event.ctrlKey) && (key === 'z' || key === 'y')) {
    event.preventDefault()
    if (key === 'y' || event.shiftKey) history.redo()
    else history.undo()
    return
  }
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
  return confirm({
    title: t('workflow.builder.leaveUnsavedTitle'),
    description: t('workflow.builder.leaveUnsavedBody'),
    action: t('workflow.builder.leave'),
    destructive: true,
  })
})

function addStep(kind: WorkflowStepKind) {
  canvas.value?.addStep(kind)
}

// A step's drawer follows the selection: selecting another step re-points it,
// clearing the selection closes it.
watch(selectedStepId, (value) => {
  if (!value && drawer.value === 'step') drawer.value = null
})

// Leaving a workflow drops its selection, its drawer and its undo stack — none
// of them mean anything against the next one.
watch(id, () => {
  selectedStepId.value = null
  drawer.value = null
  chatTurns.value = []
  chatOpen.value = false
  history.reset()
})

/* ---------------------------------------------------------------- architect */

/**
 * The conversation is local and unsaved, exactly as it is in the wizard: it
 * exists to change this graph and ends when it has. Persisting it would file a
 * chat next to the workflow it edited — the same fact in two places, and the
 * copy nobody maintains.
 */
const chatTurns = ref<WizardTurn[]>([])
const chatOpen = ref(false)
const chatUnavailable = ref(false)

/**
 * Which of the two homes the conversation gets — an inline column, or a sheet.
 *
 * Decided in script rather than by a `lg:hidden` on the sheet: that would hide
 * the panel but keep its scrim, which would sit over the canvas at exactly the
 * widths where the column is the one being used. SSR answers false, and the
 * chat starts closed, so neither renders on the first frame either way.
 */
const wideEnoughForColumn = useMediaQuery('(min-width: 1024px)')

/**
 * A proposal replaces the graph and leaves the draft dirty on purpose. The
 * architect compiles what it returns before answering, so this cannot put an
 * unsaveable graph on the canvas — but "compiles" is not "is what you meant",
 * and Save is the operator's word for that.
 *
 * The name and description are only taken when the operator has not written
 * their own: overwriting a deliberate name with a generated one is the kind of
 * loss an undo stack would have to exist to fix.
 */
function applyProposal(proposal: { graph: WorkflowGraph; name: string | null; description: string | null }) {
  if (!draft.value) return
  setGraph(detach(proposal.graph))
  canvas.value?.refit()
  if (proposal.description && !draft.value.description.trim()) draft.value.description = proposal.description
  selectedStepId.value = null
  toast.success(t('workflow.architectApplied'))
}
</script>

<template>
  <!--
    A definite height, not `flex-1`.

    The settings shell is a document column: <main> scrolls and the column
    inside it is `min-h-full`, so a flex child's height resolves from its
    content — and the canvas has none of its own to resolve from. The settings
    nav and the workflow rail already state the same number for the same
    reason: the viewport, less the topbar (h-14) and the breadcrumb strip (h-9).

    #1061: below lg the settings sections stack as a strip above, so that sum
    is short. The pane is the end of a flex chain that already fills <main>,
    so the builder grows into it instead — the canvas ends at the screen's
    edge and nothing scrolls the page. The floor keeps a usable canvas on a
    phone held sideways, where the page scrolls by the header instead.
  -->
  <div class="flex min-h-[20rem] flex-1 flex-col lg:h-[calc(100vh-5.75rem)] lg:min-h-0 lg:flex-initial">
    <!-- Header: what this is, what state it is in, and the verbs. No back
         arrow — the trail above and the roster beside it are both the way
         back, and a third one inside the pane would only be in the way. -->
    <header class="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b px-3 py-2 lg:px-4">
      <template v-if="draft">
        <!-- The name is an editable field, so the route's h1 is spoken only. -->
        <h1 class="sr-only">{{ draft.name || t('workflow.name') }}</h1>
        <Input
          v-model="draft.name"
          :disabled="!canManage"
          :aria-label="t('workflow.name')"
          class="focus-visible:border-input h-8 min-w-0 max-w-64 flex-1 border-transparent bg-transparent px-1 text-base font-semibold shadow-none focus-visible:px-2"
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
          <Button v-if="dirty" variant="ghost" size="sm" class="hidden sm:inline-flex" @click="discard">
            {{ t('common.discard') }}
          </Button>
          <Button v-if="canManage" size="sm" :disabled="!dirty || saving || errors.length > 0" @click="save">
            {{ saving ? t('workflow.settings.saving') : t('common.save') }}
          </Button>

          <!-- The architect. Beside Configure because it is the other way to
               change this graph, and it is a toggle rather than a launcher:
               pressing it again puts the canvas back to full width. -->
          <Button
            v-if="canManage && !chatUnavailable"
            :variant="chatOpen ? 'secondary' : 'outline'"
            size="sm"
            class="gap-1.5"
            :aria-pressed="chatOpen"
            @click="chatOpen = !chatOpen"
          >
            <Sparkles class="size-3.5" />
            <span class="sr-only sm:not-sr-only">{{ t('workflow.askArchitect') }}</span>
          </Button>

          <!-- Configure carries a label rather than an icon alone: the drawer
               behind it is the only way to the description and the triggers,
               and an unlabelled panel glyph does not say that. -->
          <Button variant="outline" size="sm" class="gap-1.5" @click="drawer = 'settings'">
            <PanelRight class="size-3.5" />
            <span class="sr-only sm:not-sr-only">{{ t('workflow.configure') }}</span>
          </Button>

          <!-- Deleting the workflow belongs here rather than in the drawer:
               that panel is replaced by the step form the moment a step is
               selected, so delete kept disappearing depending on what you had
               last clicked. -->
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
              <DropdownMenuItem v-if="workflow?.enabled" as-child>
                <RouterLink to="/workflows">
                  <Play class="size-3.5" />
                  {{ t('workflow.builder.seeRuns') }}
                </RouterLink>
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

    <div v-if="query.isLoading.value" class="flex min-h-0 flex-1 flex-col gap-2 p-3">
      <Skeleton class="h-8 w-full shrink-0" />
      <Skeleton class="min-h-0 flex-1" />
    </div>

    <p v-else-if="!draft" class="text-muted-foreground p-4 text-sm">{{ t('workflow.notFound') }}</p>

    <div v-else class="flex min-h-0 min-w-0 flex-1">
      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkflowCanvas
        ref="canvas"
        v-model:selected-id="selectedStepId"
        :graph="draft.graph"
        :issues="issues"
        :editable="canManage"
        @update:graph="setGraph"
      >
        <template v-if="canManage" #step="{ step: selected }">
          <WorkflowStepQuickEdit
            :step="selected"
            :graph="draft.graph"
            :issues="issues"
            @update="updateStep"
            @remove="removeStep"
            @more="drawer = 'step'"
          />
        </template>

        <!-- The toolbar, on the canvas it acts on: what can be added, and the
             history of what was. The vocabulary stays visible at once — five
             kinds is a list you learn, not a menu you search. -->
        <div
          v-if="canManage"
          class="pointer-events-none absolute inset-x-3 top-3 z-10 flex flex-wrap items-start gap-2"
        >
          <div class="kn-scroll-strip bg-card/90 pointer-events-auto max-w-full overflow-x-auto rounded-lg border p-0.5 shadow-xs backdrop-blur-md">
            <WorkflowStepPalette :can-manage="canManage" @add="addStep" />
          </div>
          <div class="bg-card/90 pointer-events-auto ml-auto flex rounded-lg border p-0.5 shadow-xs backdrop-blur-md">
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              :disabled="!history.canUndo.value"
              :aria-label="t('workflow.history.undo')"
              :title="t('workflow.history.undoHint')"
              @click="history.undo()"
            >
              <Undo2 class="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              :disabled="!history.canRedo.value"
              :aria-label="t('workflow.history.redo')"
              :title="t('workflow.history.redoHint')"
              @click="history.redo()"
            >
              <Redo2 class="size-3.5" />
            </Button>
            <span class="bg-border mx-0.5 my-1 w-px" aria-hidden="true" />
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              :aria-label="t('workflow.file.export')"
              :title="t('workflow.file.export')"
              @click="exportGraph"
            >
              <Download class="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              class="size-7"
              :aria-label="t('workflow.file.import')"
              :title="t('workflow.file.import')"
              @click="fileInput?.click()"
            >
              <Upload class="size-3.5" />
            </Button>
            <input
              ref="fileInput"
              type="file"
              accept="application/json,.json"
              class="hidden"
              tabindex="-1"
              @change="importGraph"
            />
          </div>
        </div>
      </WorkflowCanvas>

      <!-- Problems, along the bottom where a builder puts them. Each row is a
           shortcut into the step it is about, so a message is never a hunt. -->
      <footer v-if="issues.length" class="max-h-28 shrink-0 space-y-1 overflow-y-auto border-t px-3 py-2">
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
            :class="issue.severity === 'error' ? 'text-destructive' : 'text-panel-warning-ink'"
          />
          <span class="min-w-0 flex-1 leading-snug">{{ issue.message }}</span>
        </button>
      </footer>
      </div>

      <!--
        The architect, beside the canvas rather than over it.

        A drawer would be wrong here for one reason: what this conversation
        produces is a change to the thing the drawer would be covering. The
        answer to "make it three steps" is the canvas redrawing, and you have to
        be looking at it. Below `lg` there is no room for both, so it moves into
        a sheet — the same split the assistant page makes with its chat rail.
      -->
      <aside
        v-if="chatOpen && wideEnoughForColumn"
        class="flex w-80 shrink-0 flex-col border-l"
        :aria-label="t('workflow.askArchitect')"
      >
        <div class="flex h-9 shrink-0 items-center gap-2 border-b px-3">
          <Sparkles class="text-primary size-3.5 shrink-0" />
          <p class="min-w-0 flex-1 truncate text-xs font-medium">{{ t('workflow.askArchitect') }}</p>
          <Button
            variant="ghost"
            size="sm"
            class="text-muted-foreground -mr-1 size-6 p-0"
            :aria-label="t('common.close')"
            @click="chatOpen = false"
          >
            <X class="size-3.5" />
          </Button>
        </div>
        <WorkflowArchitectChat
          class="min-h-0 flex-1"
          :turns="chatTurns"
          :graph="draft.graph"
          :disabled="!canManage"
          @say="(turn) => chatTurns.push(turn)"
          @propose="applyProposal"
          @unavailable="chatUnavailable = true"
          @clear="chatTurns = []"
        />
      </aside>
    </div>

    <Sheet :open="chatOpen && !wideEnoughForColumn" @update:open="(open: boolean) => (chatOpen = open)">
      <SheetContent side="right" class="flex w-full max-w-sm flex-col p-0">
        <SheetHeader class="shrink-0 border-b px-4 py-3">
          <SheetTitle class="text-sm">{{ t('workflow.askArchitect') }}</SheetTitle>
        </SheetHeader>
        <WorkflowArchitectChat
          v-if="draft"
          class="min-h-0 flex-1"
          :turns="chatTurns"
          :graph="draft.graph"
          :disabled="!canManage"
          @say="(turn) => chatTurns.push(turn)"
          @propose="applyProposal"
          @unavailable="chatUnavailable = true"
          @clear="chatTurns = []"
        />
      </SheetContent>
    </Sheet>

    <!-- The drawer: the long fields — a step's prompt and template, or the
         workflow's description and triggers. Everything shorter is edited on
         the canvas. -->
    <Sheet :open="drawer !== null" @update:open="(open: boolean) => !open && (drawer = null)">
      <SheetContent side="right" class="w-full max-w-sm overflow-y-auto p-0">
        <SheetHeader class="sr-only">
          <SheetTitle>{{ drawer === 'step' ? t('workflow.builder.openInspector') : t('workflow.configure') }}</SheetTitle>
        </SheetHeader>
        <WorkflowStepForm
          v-if="draft && step && drawer === 'step'"
          :step="step"
          :issues="issues"
          :can-manage="canManage"
          @update="updateStep"
        />
        <WorkflowSettingsForm
          v-else-if="draft"
          v-model:description="draft.description"
          v-model:trigger="draft.trigger"
          :can-manage="canManage"
        >
          <template #footer>
            <!-- The enabled toggle has no room in the header below `sm`, so the
                 drawer carries it too rather than leaving it unreachable. -->
            <div class="space-y-2 border-t pt-3">
              <label class="flex items-center gap-2 px-1 text-xs sm:hidden">
                <Checkbox v-model="draft.enabled" :disabled="!canManage" />
                {{ t('workflow.settings.availableToRun') }}
              </label>
              <RouterLink v-if="workflow?.enabled" to="/workflows" class="block">
                <Button variant="ghost" size="sm" class="text-muted-foreground w-full justify-start">
                  <Play class="mr-1.5 size-3.5" /> {{ t('workflow.builder.seeRuns') }}
                </Button>
              </RouterLink>
            </div>
          </template>
        </WorkflowSettingsForm>
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
