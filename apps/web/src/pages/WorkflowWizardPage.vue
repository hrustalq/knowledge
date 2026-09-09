<script setup lang="ts">
/**
 * Creating a workflow (docs/features/17).
 *
 * Three steps over one frame — a fixed header carrying the stepper, a body that
 * flexes, one action bar at the bottom on every step — which is the shape the
 * import wizard already uses, so the two creation flows in this product behave
 * the same way.
 *
 * The middle step is two lanes chosen at the first: describe it to the
 * architect, or start from a shape and draw. They converge on one review,
 * because "what is it called" and "when does it start" are the same questions
 * either way, and a proposal has to be read before it is saved no matter which
 * route produced it.
 *
 * Nothing is written until Create. The architect proposes and the patterns are
 * plain data; the row appears once, at the end, and the canvas opens on it.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { createActor, type Actor } from 'xstate'
import { toast } from 'vue-sonner'
import { ArrowLeft, ArrowRight, Check, MessagesSquare, PenTool, Sparkles, TriangleAlert } from 'lucide-vue-next'
import type { WorkflowDefinitionInfo, WorkflowGraph, WorkflowValidationIssue } from '@knowledge/contracts'
import { validateGraph } from '@knowledge/workflow'
import { useApiMutation } from '@/api/queries'
import { getProjectId, getWorkspaceId } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useWorkflowsStore } from '@/stores/workflows'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import WorkflowMap from '@/components/workflows/WorkflowMap.vue'
import WorkflowArchitectChat from '@/components/workflows/WorkflowArchitectChat.vue'
import WorkflowSettingsForm from '@/components/workflows/WorkflowSettingsForm.vue'
import { describeChain } from '@/components/workflows/workflow-ui'
import { workflowPatterns } from '@/components/workflows/workflow-patterns'
import {
  clearSnapshot,
  loadSnapshot,
  saveSnapshot,
  stepOf,
  wizardMachine,
  WIZARD_STEPS,
  type WizardContext,
  type WizardStep,
} from '@/components/workflows/wizard-machine'

const { t } = useI18n()
const router = useRouter()
const auth = useAuthStore()
const store = useWorkflowsStore()

const canManage = computed(() => auth.canAdminWorkspace)

/* ------------------------------------------------------------------ machine */

const actor = shallowRef<Actor<typeof wizardMachine> | null>(null)
const state = ref<string>('approach')
const context = ref<WizardContext>({
  lane: null,
  turns: [],
  graph: null,
  name: '',
  description: '',
  trigger: { manual: true, autoStart: false, events: ['revision.indexed'], categories: [] },
  aiDisabled: false,
  error: null,
})
/** True when the machine came back from storage mid-flow, so we can say so. */
const resumed = ref(false)

onMounted(() => {
  const snapshot = loadSnapshot()
  const running = createActor(wizardMachine, snapshot ? { snapshot } : undefined)
  running.subscribe((snap) => {
    state.value = String(snap.value)
    context.value = snap.context
    saveSnapshot(running.getPersistedSnapshot())
  })
  running.start()
  actor.value = running
  resumed.value = String(running.getSnapshot().value) !== 'approach'
})

onBeforeUnmount(() => actor.value?.stop())

const send = (event: Parameters<NonNullable<typeof actor.value>['send']>[0]) => actor.value?.send(event)

const step = computed<WizardStep>(() => stepOf(state.value))
const stepIndex = computed(() => WIZARD_STEPS.indexOf(step.value))

/* ------------------------------------------------------------------- design */

const patterns = computed(() => workflowPatterns(t))
const pickedPattern = ref<string | null>(null)

function pick(key: string) {
  const pattern = patterns.value.find((p) => p.key === key)
  if (!pattern) return
  pickedPattern.value = key
  send({
    type: 'SET',
    patch: {
      graph: JSON.parse(JSON.stringify(pattern.graph)) as WorkflowGraph,
      name: context.value.name || pattern.name,
      description: context.value.description || pattern.summary,
    },
  })
}

const issues = computed<WorkflowValidationIssue[]>(() =>
  context.value.graph ? validateGraph(context.value.graph) : [],
)
const errors = computed(() => issues.value.filter((i) => i.severity === 'error'))
const invalidSteps = computed(() => errors.value.map((i) => i.stepId).filter((id): id is string => !!id))

const reading = computed(() => (context.value.graph ? describeChain(context.value.graph, t) : []))

/* ------------------------------------------------------------------- create */

const creating = ref(false)
const createWorkflow = useApiMutation('post', '/v1/workflows', { invalidates: () => [['/v1/workflows']] })

const canContinue = computed(() => {
  if (step.value === 'approach') return false
  if (step.value === 'design') return !!context.value.graph?.steps.length
  return !!context.value.name.trim() && errors.value.length === 0
})

async function create() {
  if (!context.value.graph || !canContinue.value || creating.value) return
  creating.value = true
  try {
    const created = (await createWorkflow.mutateAsync({
      body: {
        workspaceId: getWorkspaceId(),
        projectId: getProjectId(),
        name: context.value.name.trim(),
        description: context.value.description.trim() || null,
        graph: context.value.graph,
        trigger: context.value.trigger,
        // Available to run from the moment it exists. A workflow created behind
        // a switch nobody knows to flip is a workflow that silently does
        // nothing, and the review step already showed exactly what it will do.
        enabled: true,
      },
    })) as WorkflowDefinitionInfo
    await store.refresh()
    clearSnapshot()
    toast.success(t('workflow.wizard.created', { name: created.name }))
    // Into the canvas, not back to the roster: the wizard designs the shape and
    // the builder is where it is refined, so the flow ends pointed at the next
    // thing rather than at a list.
    void router.replace(`/settings/workflows/${created.id}/edit`)
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    creating.value = false
  }
}

function startOver() {
  pickedPattern.value = null
  send({ type: 'RESTART' })
}

function leave() {
  clearSnapshot()
  void router.push('/settings/workflows')
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <!-- Fixed header: where you are in the flow, and the way out. -->
    <header class="shrink-0 border-b px-4 py-3 lg:px-6">
      <div class="flex items-center gap-3">
        <div class="min-w-0 flex-1">
          <h1 class="truncate text-base font-semibold">{{ t('workflow.wizard.title') }}</h1>
          <p class="text-muted-foreground truncate text-xs">{{ t('workflow.wizard.subtitle') }}</p>
        </div>
        <Button variant="ghost" size="sm" class="text-muted-foreground shrink-0" @click="leave">
          {{ t('common.cancel') }}
        </Button>
      </div>

      <!-- The stepper. Past steps carry a tick, the current one carries the
           accent; nothing here is clickable, because Back is the way back and
           two ways to move would disagree the moment a lane branched. -->
      <ol class="mt-3 flex items-center gap-2 text-xs">
        <li v-for="(name, i) in WIZARD_STEPS" :key="name" class="flex min-w-0 items-center gap-2">
          <span
            class="grid size-5 shrink-0 place-items-center rounded-full border text-[10px] font-medium transition-colors"
            :class="
              i < stepIndex
                ? 'border-primary bg-primary text-primary-foreground'
                : i === stepIndex
                  ? 'border-primary text-primary'
                  : 'text-muted-foreground'
            "
          >
            <Check v-if="i < stepIndex" class="size-3" />
            <template v-else>{{ i + 1 }}</template>
          </span>
          <span
            class="truncate"
            :class="i === stepIndex ? 'text-foreground font-medium' : 'text-muted-foreground'"
          >
            {{ t(`workflow.wizard.step.${name}`) }}
          </span>
          <span v-if="i < WIZARD_STEPS.length - 1" class="bg-border hidden h-px w-6 shrink-0 sm:block" aria-hidden="true" />
        </li>
      </ol>
    </header>

    <!-- Body. One `kn-wf-step` per screen; the entrance is a keyframe animation
         rather than an enter-class, because removing a class needs an animation
         frame and a backgrounded tab never gets one — which strands the step
         invisible, exactly as it did in the import wizard. -->
    <div class="min-h-0 flex-1 overflow-hidden">
      <!-- 1 · Approach ---------------------------------------------------- -->
      <div v-if="step === 'approach'" :key="'approach'" class="kn-wf-step h-full overflow-y-auto">
        <!-- Top-aligned with generous air, not vertically centred: centring a
             short decision in a tall viewport drops it into the middle of an
             empty screen and reads as a page that failed to load the rest. -->
        <div class="mx-auto flex max-w-3xl flex-col gap-6 px-4 py-10 lg:py-16">
          <div>
            <h2 class="text-lg font-semibold">{{ t('workflow.wizard.approachTitle') }}</h2>
            <p class="text-muted-foreground mt-1 text-sm leading-relaxed">
              {{ t('workflow.wizard.approachBody') }}
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <button type="button" class="kn-wf-lane" :disabled="!canManage" @click="send({ type: 'CHOOSE', lane: 'describe' })">
              <span class="bg-primary/10 text-primary grid size-9 place-items-center rounded-lg">
                <MessagesSquare class="size-4.5" />
              </span>
              <span class="mt-3 block text-sm font-medium">{{ t('workflow.wizard.laneDescribe') }}</span>
              <span class="text-muted-foreground mt-1 block text-[13px] leading-snug">
                {{ t('workflow.wizard.laneDescribeBody') }}
              </span>
            </button>

            <button type="button" class="kn-wf-lane" :disabled="!canManage" @click="send({ type: 'CHOOSE', lane: 'draw' })">
              <span class="bg-muted text-muted-foreground grid size-9 place-items-center rounded-lg">
                <PenTool class="size-4.5" />
              </span>
              <span class="mt-3 block text-sm font-medium">{{ t('workflow.wizard.laneDraw') }}</span>
              <span class="text-muted-foreground mt-1 block text-[13px] leading-snug">
                {{ t('workflow.wizard.laneDrawBody') }}
              </span>
            </button>
          </div>

          <p v-if="!canManage" class="text-muted-foreground text-xs">{{ t('workflow.readOnlyAdmin') }}</p>
        </div>
      </div>

      <!-- 2 · Design ------------------------------------------------------ -->
      <div
        v-else-if="step === 'design'"
        :key="'design'"
        class="kn-wf-step grid h-full min-h-0 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]"
      >
        <!-- Left: the lane. -->
        <div class="flex min-h-0 flex-col overflow-hidden lg:border-r">
          <WorkflowArchitectChat
            v-if="context.lane === 'describe'"
            :turns="context.turns"
            :graph="context.graph"
            :disabled="context.aiDisabled || !canManage"
            @say="(turn) => send({ type: 'SAY', turn })"
            @propose="(p) => send({ type: 'PROPOSE', ...p })"
            @unavailable="send({ type: 'AI_UNAVAILABLE' })"
          />

          <div v-else class="min-h-0 flex-1 overflow-y-auto p-4">
            <h2 class="text-sm font-medium">{{ t('workflow.wizard.pickShape') }}</h2>
            <p class="text-muted-foreground mt-1 text-[13px] leading-snug">{{ t('workflow.wizard.pickShapeBody') }}</p>
            <ul class="mt-4 space-y-2">
              <li v-for="pattern in patterns" :key="pattern.key">
                <button
                  type="button"
                  class="kn-wf-pattern"
                  :class="pickedPattern === pattern.key ? 'kn-wf-pattern--picked' : ''"
                  :disabled="!canManage"
                  @click="pick(pattern.key)"
                >
                  <span class="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-md">
                    <component :is="pattern.icon" class="size-4" />
                  </span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-[13px] font-medium">{{ pattern.name }}</span>
                    <span class="text-muted-foreground mt-0.5 block text-[11px] leading-snug">{{ pattern.summary }}</span>
                  </span>
                  <Check v-if="pickedPattern === pattern.key" class="text-primary mt-px size-4 shrink-0" />
                </button>
              </li>
            </ul>
          </div>

          <p
            v-if="context.aiDisabled"
            class="text-muted-foreground shrink-0 border-t px-4 py-3 text-xs leading-relaxed"
          >
            {{ t('workflow.wizard.aiUnavailable') }}
            <button type="button" class="text-primary hover:underline" @click="send({ type: 'CHOOSE', lane: 'draw' })">
              {{ t('workflow.wizard.switchToDraw') }}
            </button>
          </p>
        </div>

        <!-- Right: the proposal, drawn. Empty until there is one, and saying so
             rather than showing a blank canvas that looks like a failure. -->
        <div class="bg-muted/15 relative hidden min-h-0 lg:block">
          <WorkflowMap
            v-if="context.graph?.steps.length"
            :graph="context.graph"
            :invalid="invalidSteps"
            :interactive="false"
          />
          <div v-else class="text-muted-foreground grid h-full place-items-center px-6 text-center text-sm">
            <p class="max-w-xs leading-relaxed">
              <Sparkles class="mx-auto mb-2 size-5 opacity-40" />
              {{ context.lane === 'describe' ? t('workflow.wizard.mapPendingAi') : t('workflow.wizard.mapPendingDraw') }}
            </p>
          </div>
        </div>
      </div>

      <!-- 3 · Review ------------------------------------------------------ -->
      <div v-else :key="'review'" class="kn-wf-step h-full overflow-y-auto">
        <div class="mx-auto grid max-w-5xl gap-6 px-4 py-6 lg:grid-cols-[minmax(0,1fr)_20rem] lg:px-6">
          <div class="min-w-0 space-y-5">
            <div>
              <h2 class="text-lg font-semibold">{{ t('workflow.wizard.reviewTitle') }}</h2>
              <p class="text-muted-foreground mt-1 text-sm leading-relaxed">{{ t('workflow.wizard.reviewBody') }}</p>
            </div>

            <label class="block space-y-1.5">
              <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.name') }}</span>
              <Input
                :model-value="context.name"
                :placeholder="t('workflow.wizard.namePlaceholder')"
                :aria-invalid="!context.name.trim() || undefined"
                @update:model-value="(v) => send({ type: 'SET', patch: { name: String(v) } })"
              />
            </label>

            <!-- The shape, and the same shape in words. The canvas is the fast
                 read; the sentences are what a reader without it gets, and the
                 only place the chain's real consequences are spelled out. -->
            <div class="overflow-hidden rounded-xl border">
              <div class="bg-muted/15 h-56">
                <WorkflowMap
                  v-if="context.graph"
                  :graph="context.graph"
                  :invalid="invalidSteps"
                  :interactive="false"
                />
              </div>
              <ol class="divide-y">
                <li v-for="(line, i) in reading" :key="line.id" class="flex gap-3 px-4 py-2.5">
                  <span class="text-muted-foreground w-4 shrink-0 text-right text-xs tabular-nums">{{ i + 1 }}</span>
                  <span class="min-w-0 flex-1">
                    <span class="block text-[13px] font-medium">{{ line.title }}</span>
                    <span class="text-muted-foreground block text-xs leading-snug">{{ line.sentence }}</span>
                  </span>
                </li>
              </ol>
            </div>

            <ul v-if="issues.length" class="space-y-1">
              <li v-for="(issue, i) in issues" :key="i" class="flex gap-1.5 text-xs leading-snug">
                <TriangleAlert
                  class="mt-px size-3.5 shrink-0"
                  :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
                />
                <span class="min-w-0 flex-1">{{ issue.message }}</span>
              </li>
            </ul>
          </div>

          <aside class="min-w-0 rounded-xl border">
            <WorkflowSettingsForm
              bare
              :description="context.description"
              :trigger="context.trigger"
              :can-manage="canManage"
              @update:description="(v) => send({ type: 'SET', patch: { description: v } })"
              @update:trigger="(v) => send({ type: 'SET', patch: { trigger: v } })"
            />
          </aside>
        </div>
      </div>
    </div>

    <!-- One action bar, on every step. -->
    <footer class="flex shrink-0 items-center gap-2 border-t px-4 py-3 lg:px-6">
      <Button
        v-if="step !== 'approach'"
        variant="ghost"
        size="sm"
        class="gap-1.5"
        @click="send({ type: 'BACK' })"
      >
        <ArrowLeft class="size-4" /> {{ t('common.back') }}
      </Button>
      <Button
        v-if="resumed && step !== 'approach'"
        variant="ghost"
        size="sm"
        class="text-muted-foreground"
        @click="startOver"
      >
        {{ t('workflow.wizard.startOver') }}
      </Button>

      <p class="text-muted-foreground ml-auto hidden text-xs sm:block">
        {{ t(`workflow.wizard.footer.${step}`) }}
      </p>

      <Button
        v-if="step === 'design'"
        size="sm"
        class="gap-1.5"
        :disabled="!canContinue"
        @click="send({ type: 'NEXT' })"
      >
        {{ t('common.continue') }} <ArrowRight class="size-4" />
      </Button>
      <Button v-else-if="step === 'review'" size="sm" :disabled="!canContinue || creating" @click="create">
        {{ creating ? t('workflow.wizard.creating') : t('workflow.wizard.create') }}
      </Button>
    </footer>
  </div>
</template>

<style scoped>
/* Keyframes, not enter-classes: see the comment on the body above. */
.kn-wf-step {
  animation: kn-wf-step-in 260ms cubic-bezier(0.32, 0.72, 0, 1) both;
}
@keyframes kn-wf-step-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.kn-wf-lane {
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--card);
  padding: 1.25rem;
  text-align: left;
  transition:
    border-color 160ms ease-out,
    box-shadow 160ms ease-out,
    transform 160ms ease-out;
}
.kn-wf-lane:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--primary) 40%, var(--border));
  transform: translateY(-1px);
}
.kn-wf-lane:focus-visible {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}
.kn-wf-lane:disabled {
  opacity: 0.55;
}

.kn-wf-pattern {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 0.625rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--card);
  padding: 0.625rem 0.75rem;
  text-align: left;
  transition:
    border-color 160ms ease-out,
    background-color 160ms ease-out;
}
.kn-wf-pattern:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--primary) 35%, var(--border));
}
.kn-wf-pattern--picked {
  border-color: var(--primary);
  background: color-mix(in oklab, var(--primary) 5%, transparent);
}
.kn-wf-pattern:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--ring) 50%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .kn-wf-step {
    animation-duration: 0.01ms;
  }
  .kn-wf-lane,
  .kn-wf-pattern {
    transition-duration: 0.01ms;
  }
  .kn-wf-lane:hover:not(:disabled) {
    transform: none;
  }
}
</style>
