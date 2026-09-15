<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { ArrowRight, Trash2 } from 'lucide-vue-next'
import {
  AUTHORABLE_RELATION_TYPES,
  DOCUMENT_CATEGORIES,
  isAuthorableRelationType,
  type DocumentCategory,
  type WorkflowGraph,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowValidationIssue,
} from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { STEP_KINDS, stepKind } from './workflow-ui'

const { t } = useI18n()

/**
 * The step inspector (docs/features/17).
 *
 * The canvas owns structure; this owns behaviour. It reads top to bottom as one
 * sentence — *what this step does, what it is told, what happens to the result*
 * — rather than as a pile of checkboxes, because the three switches that used to
 * sit here (fan out / auto-approve / creates a page) are not independent
 * settings. They are one decision about the step's output, and asking it three
 * times is what made the old panel feel like a form.
 */
const props = defineProps<{
  step: WorkflowStep
  graph: WorkflowGraph
  issues: WorkflowValidationIssue[]
  canManage: boolean
}>()

const emit = defineEmits<{ update: [WorkflowStep]; remove: [string]; select: [string] }>()

const isAi = computed(() => props.step.kind === 'ai.generate' || props.step.kind === 'ai.draft')
const myIssues = computed(() => props.issues.filter((i) => i.stepId === props.step.id))
const kindMeta = computed(() => stepKind(props.step.kind))

function patch(fields: Partial<WorkflowStep>) {
  emit('update', { ...props.step, ...fields })
}

/** The Select only offers allowed types; the guard keeps the narrowed contract honest. */
function setRelationToParent(value: unknown) {
  const next = String(value)
  if (isAuthorableRelationType(next)) setProduces({ relationToParent: next })
}

function setKind(kind: WorkflowStepKind) {
  patch({
    kind,
    fanOut: kind === 'ai.generate',
    // Switching kind keeps the prompt: doing it by accident should not throw
    // away what someone wrote.
    ...(kind === 'ai.generate' || kind === 'ai.draft' ? { prompt: props.step.prompt ?? { user: '' } } : {}),
  })
}

/**
 * The one output decision, as three named outcomes instead of three booleans.
 * "Publishes" and "Publishes without asking" differ only in the review gate, so
 * they belong on the same axis rather than in separate checkboxes.
 */
type Outcome = 'items' | 'page' | 'page-auto' | 'internal'

const outcome = computed<Outcome>(() => {
  if (props.step.fanOut) return 'items'
  if (!props.step.produces) return 'internal'
  return props.step.autoApprove ? 'page-auto' : 'page'
})

const OUTCOMES: Array<{ value: Outcome; label: string; hint: string }> = [
  { value: 'items', label: t('workflow.outcome.items'), hint: t('workflow.outcome.itemsHint') },
  { value: 'page', label: t('workflow.outcome.page'), hint: t('workflow.outcome.pageHint') },
  { value: 'page-auto', label: t('workflow.outcome.pageAuto'), hint: t('workflow.outcome.pageAutoHint') },
  { value: 'internal', label: t('workflow.outcome.internal'), hint: t('workflow.outcome.internalHint') },
]

function setOutcome(next: Outcome) {
  const produces = props.step.produces ?? { category: 'other' as DocumentCategory, relationToParent: 'IMPLEMENTS' }
  if (next === 'items') return patch({ fanOut: true, autoApprove: false, produces })
  if (next === 'internal') return patch({ fanOut: false, autoApprove: false, produces: undefined })
  patch({ fanOut: false, autoApprove: next === 'page-auto', produces })
}

function setProduces(fields: Partial<NonNullable<WorkflowStep['produces']>>) {
  patch({
    produces: { category: 'other', relationToParent: 'IMPLEMENTS', ...props.step.produces, ...fields },
  })
}

const nextSteps = computed(() =>
  props.step.next
    .map((id) => props.graph.steps.find((s) => s.id === id))
    .filter((s): s is WorkflowStep => Boolean(s)),
)
const addable = computed(() =>
  props.graph.steps.filter((s) => s.id !== props.step.id && !props.step.next.includes(s.id)),
)

const promptPlaceholder = computed(() =>
  props.step.kind === 'ai.generate'
    ? 'List the use cases this entity takes part in.'
    : 'Write the API endpoint specification for this use case.',
)
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <header class="flex items-start justify-between gap-2 border-b px-4 py-3">
      <div class="flex min-w-0 items-center gap-2">
        <component :is="kindMeta?.icon" class="text-muted-foreground size-4 shrink-0" />
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">{{ step.title || step.id }}</p>
          <p class="text-muted-foreground truncate font-mono text-[11px]">{{ step.id }}</p>
        </div>
      </div>
      <Button
        v-if="canManage"
        variant="ghost"
        size="sm"
        class="text-muted-foreground hover:text-destructive -mr-1 size-7 shrink-0 p-0"
        :title="t('workflow.removeStep')"
        @click="emit('remove', step.id)"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </header>

    <div class="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
      <ul v-if="myIssues.length" class="space-y-1">
        <li
          v-for="(issue, i) in myIssues"
          :key="i"
          class="flex gap-1.5 text-xs leading-snug"
          :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
        >
          <span aria-hidden="true">•</span>{{ issue.message }}
        </li>
      </ul>

      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.name') }}</span>
        <Input
          :model-value="step.title"
          :disabled="!canManage"
          :placeholder="t('workflow.stepTitlePlaceholder')"
          @update:model-value="(v) => patch({ title: String(v) })"
        />
      </label>

      <!-- Kind: a segmented row, not four stacked cards. It is chosen once. -->
      <div class="space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.does') }}</span>
        <div class="bg-muted/50 grid grid-cols-4 gap-0.5 rounded-md p-0.5">
          <button
            v-for="kind in STEP_KINDS"
            :key="kind.value"
            type="button"
            :disabled="!canManage"
            :aria-pressed="step.kind === kind.value"
            :title="t(kind.hint)"
            class="focus-visible:ring-ring flex flex-col items-center gap-1 rounded px-1 py-1.5 text-[10px] leading-tight transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
            :class="
              step.kind === kind.value
                ? 'bg-background text-foreground shadow-xs font-medium'
                : 'text-muted-foreground hover:text-foreground'
            "
            @click="setKind(kind.value)"
          >
            <component :is="kind.icon" class="size-3.5" />
            <span class="text-center">{{ t(kind.short) }}</span>
          </button>
        </div>
        <p class="text-muted-foreground text-[11px] leading-snug">{{ kindMeta ? t(kindMeta.hint) : '' }}</p>
      </div>

      <label v-if="isAi" class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.toldTo') }}</span>
        <Textarea
          :model-value="step.prompt?.user ?? ''"
          :disabled="!canManage"
          rows="4"
          :placeholder="promptPlaceholder"
          @update:model-value="(v) => patch({ prompt: { ...step.prompt, user: String(v) } })"
        />
        <span class="text-muted-foreground block text-[11px] leading-snug">
          {{ t('workflow.form.promptHint') }}
        </span>
      </label>

      <!-- One decision about the output, not three booleans. -->
      <div class="space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.produces') }}</span>
        <div class="divide-y overflow-hidden rounded-md border">
          <button
            v-for="option in OUTCOMES"
            :key="option.value"
            type="button"
            :disabled="!canManage"
            :aria-pressed="outcome === option.value"
            class="focus-visible:ring-ring block w-full px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:-outline-offset-2 disabled:opacity-60"
            :class="outcome === option.value ? 'bg-primary/5' : 'hover:bg-muted/40'"
            @click="setOutcome(option.value)"
          >
            <span class="flex items-center gap-2">
              <span
                class="size-1.5 shrink-0 rounded-full"
                :class="outcome === option.value ? 'bg-primary' : 'bg-muted-foreground/30'"
              />
              <span class="text-xs font-medium">{{ option.label }}</span>
            </span>
            <span class="text-muted-foreground mt-0.5 block pl-3.5 text-[11px] leading-snug">
              {{ option.hint }}
            </span>
          </button>
        </div>
      </div>

      <div v-if="step.produces" class="space-y-3">
        <div class="grid grid-cols-2 gap-2">
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.filedAs') }}</span>
            <Select
              :model-value="step.produces.category"
              :disabled="!canManage"
              @update:model-value="(v) => setProduces({ category: String(v) as DocumentCategory })"
            >
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ t(`category.${c}`) }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label class="block space-y-1.5">
            <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.linkedBy') }}</span>
            <Select
              :model-value="step.produces.relationToParent"
              :disabled="!canManage"
              @update:model-value="setRelationToParent"
            >
              <SelectTrigger class="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in AUTHORABLE_RELATION_TYPES" :key="r" :value="r">{{ r }}</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <p class="text-muted-foreground text-[11px] leading-snug">
          {{ t('workflow.form.nestingHint') }}
        </p>
      </div>

      <label v-if="step.fanOut" class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.atMost') }}</span>
        <div class="flex items-center gap-2">
          <Input
            type="number"
            min="1"
            max="50"
            class="w-20"
            :model-value="step.maxItems ?? 8"
            :disabled="!canManage"
            @update:model-value="(v) => patch({ maxItems: Number(v) || undefined })"
          />
          <span class="text-muted-foreground text-[11px]">{{ t('workflow.form.maxItemsHint') }}</span>
        </div>
      </label>

      <!-- Downstream steps read as the chain they are, and each is a shortcut
           into that step rather than a checkbox to hunt through. -->
      <div class="space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.then') }}</span>
        <ul v-if="nextSteps.length" class="space-y-1">
          <li v-for="target in nextSteps" :key="target.id" class="flex items-center gap-1.5">
            <ArrowRight class="text-muted-foreground size-3 shrink-0" />
            <button
              type="button"
              class="hover:text-primary min-w-0 flex-1 truncate text-left text-xs hover:underline"
              @click="emit('select', target.id)"
            >
              {{ target.title || target.id }}
            </button>
            <Button
              v-if="canManage"
              variant="ghost"
              size="sm"
              class="text-muted-foreground hover:text-destructive size-6 shrink-0 p-0"
              :title="t('workflow.disconnect')"
              @click="patch({ next: step.next.filter((n) => n !== target.id) })"
            >
              <Trash2 class="size-3" />
            </Button>
          </li>
        </ul>
        <p v-else class="text-muted-foreground text-[11px]">{{ t('workflow.form.nothingAfter') }}</p>

        <Select
          v-if="canManage && addable.length"
          model-value=""
          @update:model-value="(v) => v && patch({ next: [...step.next, String(v)] })"
        >
          <SelectTrigger class="h-8 w-full text-xs">
            <SelectValue :placeholder="t('workflow.connectStep')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="option in addable" :key="option.id" :value="option.id">
              {{ option.title || option.id }}
            </SelectItem>
          </SelectContent>
        </Select>
        <p class="text-muted-foreground text-[11px]">{{ t('workflow.form.dragHint') }}</p>
      </div>
    </div>
  </div>
</template>
