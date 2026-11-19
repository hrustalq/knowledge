<script setup lang="ts">
/**
 * The selected step, edited where it sits (#1246).
 *
 * Everything that is a choice rather than prose: what the step does, what
 * leaves it, where its pages are filed, what runs after it. The prose — a
 * prompt, a template, the cap — is the drawer's, because a textarea in a
 * popover over the graph is the drawer again, only smaller.
 *
 * "Then" doubles as the keyboard's way to connect and disconnect: dragging
 * between dots is the pointer's gesture, and this list is the same edit.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowRight, PanelRight, Trash2, X } from 'lucide-vue-next'
import {
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type WorkflowGraph,
  type WorkflowStep,
  type WorkflowValidationIssue,
} from '@knowledge/contracts'
import { Button } from '@knowledge/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { STEP_KINDS } from '@/entities/workflow'
import { STEP_OUTCOMES, outcomeOf, withKind, withOutcome, withProduces, type StepOutcome } from '../model/step-edits'

const props = defineProps<{
  step: WorkflowStep
  graph: WorkflowGraph
  issues: WorkflowValidationIssue[]
}>()

const emit = defineEmits<{ update: [WorkflowStep]; remove: [string]; more: [] }>()

const { t } = useI18n()

const problem = computed(() => props.issues.find((i) => i.stepId === props.step.id && i.severity === 'error'))
const outcome = computed(() => outcomeOf(props.step))
const outcomeHint = computed(() => STEP_OUTCOMES.find((o) => o.value === outcome.value)?.hint ?? '')

const nextSteps = computed(() =>
  props.step.next.map((id) => props.graph.steps.find((s) => s.id === id)).filter((s): s is WorkflowStep => !!s),
)
const addable = computed(() =>
  props.graph.steps.filter((s) => s.id !== props.step.id && !props.step.next.includes(s.id)),
)

/** Whether the drawer has anything to say about this step. */
const hasLongFields = computed(
  () =>
    props.step.kind === 'ai.generate' ||
    props.step.kind === 'ai.draft' ||
    props.step.kind === 'task.update' ||
    !!props.step.produces ||
    props.step.fanOut,
)
</script>

<template>
  <div class="text-sm">
    <header class="flex items-center gap-2 border-b px-3 py-2">
      <p class="min-w-0 flex-1 truncate font-medium">{{ step.title || step.id }}</p>
      <kbd class="text-muted-foreground bg-muted text-micro shrink-0 rounded px-1 py-px font-sans pointer-coarse:hidden">
        {{ t('workflow.quick.renameKey') }}
      </kbd>
    </header>

    <div class="space-y-3 px-3 py-3">
      <p v-if="problem" class="text-destructive text-caption leading-snug">{{ problem.message }}</p>

      <!-- Kind: five icons in one row. Chosen once, so it is a row, not a list. -->
      <div class="space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.does') }}</span>
        <div class="bg-muted/50 grid grid-cols-5 gap-0.5 rounded-md p-0.5" role="group" :aria-label="t('workflow.form.does')">
          <button
            v-for="kind in STEP_KINDS"
            :key="kind.value"
            type="button"
            :aria-pressed="step.kind === kind.value"
            :aria-label="t(kind.label)"
            :title="`${t(kind.label)} — ${t(kind.hint)}`"
            class="focus-visible:ring-ring grid h-8 place-items-center rounded transition-colors focus-visible:ring-2 focus-visible:outline-none"
            :class="
              step.kind === kind.value
                ? 'bg-background text-foreground shadow-xs'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="emit('update', withKind(step, kind.value))"
          >
            <component :is="kind.icon" class="size-4" />
          </button>
        </div>
      </div>

      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.produces') }}</span>
        <Select
          :model-value="outcome"
          @update:model-value="(v) => emit('update', withOutcome(step, String(v) as StepOutcome))"
        >
          <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in STEP_OUTCOMES" :key="option.value" :value="option.value">
              {{ t(option.label) }}
            </SelectItem>
          </SelectContent>
        </Select>
        <span class="text-muted-foreground text-caption block leading-snug">{{ t(outcomeHint) }}</span>
      </label>

      <label v-if="step.produces" class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.filedAs') }}</span>
        <Select
          :model-value="step.produces.category"
          @update:model-value="(v) => emit('update', withProduces(step, { category: String(v) as DocumentCategory }))"
        >
          <SelectTrigger class="h-8 w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ t(`category.${c}`) }}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      <div class="space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.then') }}</span>
        <ul v-if="nextSteps.length" class="space-y-0.5">
          <li v-for="target in nextSteps" :key="target.id" class="flex items-center gap-1.5">
            <ArrowRight class="text-muted-foreground size-3 shrink-0" />
            <span class="min-w-0 flex-1 truncate text-xs">{{ target.title || target.id }}</span>
            <Button
              variant="ghost"
              size="icon-xs"
              class="text-muted-foreground hover:text-destructive shrink-0"
              :aria-label="`${t('workflow.disconnect')}: ${target.title || target.id}`"
              :title="t('workflow.disconnect')"
              @click="emit('update', { ...step, next: step.next.filter((n) => n !== target.id) })"
            >
              <X />
            </Button>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-caption">{{ t('workflow.form.nothingAfter') }}</p>
        <Select
          v-if="addable.length"
          model-value=""
          @update:model-value="(v) => v && emit('update', { ...step, next: [...step.next, String(v)] })"
        >
          <SelectTrigger class="h-8 w-full text-xs" :aria-label="t('workflow.connectStep')">
            <SelectValue :placeholder="t('workflow.connectStep')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in addable" :key="option.id" :value="option.id">
              {{ option.title || option.id }}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>

    <footer class="flex items-center gap-1 border-t px-2 py-1.5">
      <Button v-if="hasLongFields" variant="ghost" size="sm" class="gap-1.5" @click="emit('more')">
        <PanelRight class="size-3.5" />
        {{ t('workflow.quick.more') }}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class="text-muted-foreground hover:text-destructive ml-auto gap-1.5"
        @click="emit('remove', step.id)"
      >
        <Trash2 class="size-3.5" />
        {{ t('workflow.quick.remove') }}
      </Button>
    </footer>
  </div>
</template>
