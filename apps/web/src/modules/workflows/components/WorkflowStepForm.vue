<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, onMounted } from 'vue'
import {
  AUTHORABLE_RELATION_TYPES,
  isAuthorableRelationType,
  type WorkflowStep,
  type WorkflowValidationIssue,
} from '@knowledge/contracts'
import { Input } from '@knowledge/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@knowledge/ui/select'
import { Textarea } from '@knowledge/ui/textarea'
import { useTemplatesStore } from '@/entities/template'
import { stepKind } from '@/entities/workflow'
import { withProduces } from '../model/step-edits'

const { t } = useI18n()

/**
 * A step's long fields, in the builder's drawer (docs/features/17, #1246).
 *
 * The choices — kind, output, category, what runs next — are made on the
 * canvas, in the popover on the step itself. What is left here is what needs
 * room: the prompt, the template a draft is written into, the relation its
 * pages are linked by, and the fan-out cap.
 *
 * Typed fields emit with a key, so a sentence typed into the prompt undoes as
 * one edit rather than a keystroke at a time.
 */
const props = defineProps<{
  step: WorkflowStep
  issues: WorkflowValidationIssue[]
  canManage: boolean
}>()

const emit = defineEmits<{ update: [step: WorkflowStep, key?: string] }>()

// task.update has no model call, but its prompt is the comment it posts, and
// `validateGraph` refuses an empty one — so it gets the field too.
const hasPrompt = computed(() => ['ai.generate', 'ai.draft', 'task.update'].includes(props.step.kind))
const myIssues = computed(() => props.issues.filter((i) => i.stepId === props.step.id))
const kindMeta = computed(() => stepKind(props.step.kind))

/** The Select only offers allowed types; the guard keeps the narrowed contract honest. */
function setRelationToParent(value: unknown) {
  const next = String(value)
  if (isAuthorableRelationType(next)) emit('update', withProduces(props.step, { relationToParent: next }))
}

/**
 * The page template an `ai.draft` step writes into (issue #69). Only a drafting
 * step fills a body, so only it is offered one. Picking a template files its
 * pages under the template's category — still changeable on the canvas.
 */
const templates = useTemplatesStore()
onMounted(() => void templates.ensureLoaded())

const NO_TEMPLATE = '__none__'
const canTemplate = computed(() => props.step.kind === 'ai.draft' && Boolean(props.step.produces))
const templateOptions = computed(() => {
  const current = props.step.produces?.templateRef
  const offered = templates.offered.map((tpl) => ({ ref: tpl.ref, label: `${tpl.icon ?? ''} ${tpl.name}`.trim() }))
  // An archived template, or one this project does not offer, still has to
  // show as the step's value rather than as a blank select.
  if (current && !offered.some((o) => o.ref === current)) {
    offered.push({ ref: current, label: templates.byRef(current)?.name ?? current })
  }
  return offered
})

// Named here rather than left to the Select: the roster loads after the panel
// opens, and a Select whose items arrive late shows its raw value — the ref.
const templateLabel = computed(() => {
  const current = props.step.produces?.templateRef
  return current ? templateOptions.value.find((o) => o.ref === current)?.label ?? current : t('workflow.form.noTemplate')
})

function setTemplate(value: unknown) {
  const ref = String(value)
  if (ref === NO_TEMPLATE) return emit('update', withProduces(props.step, { templateRef: undefined }))
  const summary = templates.byRef(ref)
  emit('update', withProduces(props.step, { templateRef: ref, ...(summary ? { category: summary.category } : {}) }))
}

const promptPlaceholder = computed(() =>
  props.step.kind === 'ai.generate' ? t('workflow.promptPlaceholderGenerate') : t('workflow.promptPlaceholderDraft'),
)
</script>

<template>
  <div class="flex min-h-0 flex-col">
    <header class="flex items-center gap-2 border-b px-4 py-3">
      <component :is="kindMeta?.icon" class="text-muted-foreground size-4 shrink-0" />
      <div class="min-w-0">
        <p class="truncate text-sm font-medium">{{ step.title || step.id }}</p>
        <p class="text-muted-foreground text-caption truncate font-mono">{{ step.id }}</p>
      </div>
    </header>

    <div class="min-h-0 flex-1 space-y-5 overflow-auto px-4 py-4">
      <ul v-if="myIssues.length" class="space-y-1">
        <li
          v-for="(issue, i) in myIssues"
          :key="i"
          class="flex gap-1.5 text-xs leading-snug"
          :class="issue.severity === 'error' ? 'text-destructive' : 'text-panel-warning-ink'"
        >
          <span aria-hidden="true">•</span>{{ issue.message }}
        </li>
      </ul>

      <label v-if="hasPrompt" class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.toldTo') }}</span>
        <Textarea
          :model-value="step.prompt?.user ?? ''"
          :disabled="!canManage"
          rows="8"
          :placeholder="promptPlaceholder"
          @update:model-value="(v) => emit('update', { ...step, prompt: { ...step.prompt, user: String(v) } }, `prompt:${step.id}`)"
        />
        <span class="text-muted-foreground text-caption block leading-snug">
          {{ t('workflow.form.promptHint') }}
        </span>
      </label>

      <div v-if="step.produces" class="space-y-3">
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
          <span class="text-muted-foreground text-caption block leading-snug">
            {{ t('workflow.form.nestingHint') }}
          </span>
        </label>
        <label v-if="canTemplate" class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.form.template') }}</span>
          <Select
            :model-value="step.produces.templateRef ?? NO_TEMPLATE"
            :disabled="!canManage"
            @update:model-value="setTemplate"
          >
            <SelectTrigger class="w-full"><SelectValue>{{ templateLabel }}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem :value="NO_TEMPLATE">{{ t('workflow.form.noTemplate') }}</SelectItem>
              <SelectItem v-for="option in templateOptions" :key="option.ref" :value="option.ref">
                {{ option.label }}
              </SelectItem>
            </SelectContent>
          </Select>
          <span class="text-muted-foreground text-caption block leading-snug">
            {{ t('workflow.form.templateHint') }}
          </span>
        </label>
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
            @update:model-value="(v) => emit('update', { ...step, maxItems: Number(v) || undefined }, `max:${step.id}`)"
          />
          <span class="text-muted-foreground text-caption">{{ t('workflow.form.maxItemsHint') }}</span>
        </div>
      </label>
    </div>
  </div>
</template>
