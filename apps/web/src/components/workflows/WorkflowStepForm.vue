<script setup lang="ts">
import { computed } from 'vue'
import { Trash2 } from 'lucide-vue-next'
import {
  DOCUMENT_CATEGORIES,
  type DocumentCategory,
  type WorkflowGraph,
  type WorkflowStep,
  type WorkflowStepKind,
  type WorkflowValidationIssue,
} from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { STEP_KINDS, stepKind } from './workflow-ui'

/**
 * Everything a step *does* (docs/features/17). The canvas owns structure; this
 * owns behaviour, which is why it is a panel and not a bigger node.
 */
const props = defineProps<{
  step: WorkflowStep
  graph: WorkflowGraph
  issues: WorkflowValidationIssue[]
  canManage: boolean
}>()

const emit = defineEmits<{ update: [WorkflowStep]; remove: [string] }>()

const RELATION_TYPES = ['IMPLEMENTS', 'DESCRIBES', 'DEPENDS_ON', 'RELATED_TO', 'SUPERSEDES'] as const

const isAi = computed(() => props.step.kind === 'ai.generate' || props.step.kind === 'ai.draft')
const myIssues = computed(() => props.issues.filter((i) => i.stepId === props.step.id))

function patch(fields: Partial<WorkflowStep>) {
  emit('update', { ...props.step, ...fields })
}

function setKind(kind: WorkflowStepKind) {
  patch({
    kind,
    fanOut: kind === 'ai.generate',
    // A step that stops being an AI step keeps its prompt: switching kind by
    // accident should not silently throw away what someone wrote.
    ...(kind === 'ai.generate' || kind === 'ai.draft' ? { prompt: props.step.prompt ?? { user: '' } } : {}),
  })
}

function toggleProduces(on: boolean) {
  patch(
    on
      ? { produces: props.step.produces ?? { category: 'other', relationToParent: 'IMPLEMENTS' } }
      : { produces: undefined },
  )
}

function setProduces(fields: Partial<NonNullable<WorkflowStep['produces']>>) {
  patch({
    produces: { category: 'other', relationToParent: 'IMPLEMENTS', ...props.step.produces, ...fields },
  })
}

const nextOptions = computed(() => props.graph.steps.filter((s) => s.id !== props.step.id))

function toggleNext(id: string, on: boolean) {
  patch({ next: on ? [...props.step.next, id] : props.step.next.filter((n) => n !== id) })
}
</script>

<template>
  <div class="space-y-5">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <h3 class="truncate text-sm font-semibold">{{ step.title || step.id }}</h3>
        <p class="text-muted-foreground mt-0.5 font-mono text-[11px]">{{ step.id }}</p>
      </div>
      <Button
        v-if="canManage"
        variant="ghost"
        size="sm"
        class="text-muted-foreground hover:text-destructive h-7 shrink-0 px-2"
        @click="emit('remove', step.id)"
      >
        <Trash2 class="size-3.5" />
      </Button>
    </div>

    <ul v-if="myIssues.length" class="space-y-1 text-xs">
      <li
        v-for="(issue, i) in myIssues"
        :key="i"
        :class="issue.severity === 'error' ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'"
      >
        {{ issue.message }}
      </li>
    </ul>

    <label class="block space-y-1.5">
      <span class="text-muted-foreground text-xs font-medium">Title</span>
      <Input
        :model-value="step.title"
        :disabled="!canManage"
        placeholder="Use cases"
        @update:model-value="(v) => patch({ title: String(v) })"
      />
    </label>

    <div class="space-y-1.5">
      <span class="text-muted-foreground text-xs font-medium">What this step does</span>
      <div class="grid gap-1.5">
        <button
          v-for="kind in STEP_KINDS"
          :key="kind.value"
          type="button"
          :disabled="!canManage"
          class="focus-visible:ring-ring flex items-start gap-2 rounded-md border p-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60"
          :class="
            step.kind === kind.value ? 'border-primary bg-primary/5' : 'hover:border-border hover:bg-muted/40'
          "
          @click="setKind(kind.value)"
        >
          <component :is="kind.icon" class="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span class="min-w-0">
            <span class="block text-xs font-medium">{{ kind.label }}</span>
            <span class="text-muted-foreground block text-[11px] leading-snug">{{ kind.hint }}</span>
          </span>
        </button>
      </div>
    </div>

    <template v-if="isAi">
      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">Instructions</span>
        <Textarea
          :model-value="step.prompt?.user ?? ''"
          :disabled="!canManage"
          rows="4"
          :placeholder="
            step.kind === 'ai.generate'
              ? 'List the use cases this entity participates in.'
              : 'Write the API endpoint specification for this use case.'
          "
          @update:model-value="(v) => patch({ prompt: { ...step.prompt, user: String(v) } })"
        />
        <span class="text-muted-foreground block text-[11px]">
          The source page and the parent item are supplied automatically — describe the job, not the context.
        </span>
      </label>

      <label v-if="step.fanOut" class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">Maximum items</span>
        <Input
          type="number"
          min="1"
          max="50"
          :model-value="step.maxItems ?? 8"
          :disabled="!canManage"
          @update:model-value="(v) => patch({ maxItems: Number(v) || undefined })"
        />
        <span class="text-muted-foreground block text-[11px]">
          A cap, so one over-eager list cannot open two hundred nodes.
        </span>
      </label>
    </template>

    <div class="space-y-2">
      <label class="flex items-start gap-2">
        <Checkbox
          :model-value="step.fanOut"
          :disabled="!canManage || step.kind !== 'ai.generate'"
          @update:model-value="(v) => patch({ fanOut: Boolean(v) })"
        />
        <span class="min-w-0">
          <span class="block text-xs font-medium">Fan out</span>
          <span class="text-muted-foreground block text-[11px] leading-snug">
            Produce several items, each becoming its own reviewable node.
          </span>
        </span>
      </label>

      <label class="flex items-start gap-2">
        <Checkbox
          :model-value="step.autoApprove"
          :disabled="!canManage"
          @update:model-value="(v) => patch({ autoApprove: Boolean(v) })"
        />
        <span class="min-w-0">
          <span class="block text-xs font-medium">Publish without review</span>
          <span class="text-muted-foreground block text-[11px] leading-snug">
            Skips the human gate. The run no longer stops here.
          </span>
        </span>
      </label>

      <label class="flex items-start gap-2">
        <Checkbox
          :model-value="Boolean(step.produces)"
          :disabled="!canManage"
          @update:model-value="(v) => toggleProduces(Boolean(v))"
        />
        <span class="min-w-0">
          <span class="block text-xs font-medium">Creates a page</span>
          <span class="text-muted-foreground block text-[11px] leading-snug">
            Approved drafts become real pages. Off means the step only feeds the next one.
          </span>
        </span>
      </label>
    </div>

    <div v-if="step.produces" class="border-l-2 pl-3 space-y-3">
      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">Category</span>
        <select
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          :value="step.produces.category"
          :disabled="!canManage"
          @change="(e) => setProduces({ category: (e.target as HTMLSelectElement).value as DocumentCategory })"
        >
          <option v-for="c in DOCUMENT_CATEGORIES" :key="c" :value="c">{{ c }}</option>
        </select>
      </label>

      <label class="block space-y-1.5">
        <span class="text-muted-foreground text-xs font-medium">Relation to the page above</span>
        <select
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 text-sm focus-visible:ring-2 focus-visible:outline-none"
          :value="step.produces.relationToParent"
          :disabled="!canManage"
          @change="(e) => setProduces({ relationToParent: (e.target as HTMLSelectElement).value })"
        >
          <option v-for="r in RELATION_TYPES" :key="r" :value="r">{{ r }}</option>
        </select>
      </label>

      <label class="flex items-start gap-2">
        <Checkbox
          :model-value="step.produces.nestUnderParent !== false"
          :disabled="!canManage"
          @update:model-value="(v) => setProduces({ nestUnderParent: Boolean(v) })"
        />
        <span class="text-xs">Nest the new page under its parent</span>
      </label>
    </div>

    <div v-if="nextOptions.length" class="space-y-1.5">
      <span class="text-muted-foreground text-xs font-medium">Then run</span>
      <p class="text-muted-foreground text-[11px]">
        Also editable by dragging a connection on the canvas.
      </p>
      <label v-for="option in nextOptions" :key="option.id" class="flex items-center gap-2">
        <Checkbox
          :model-value="step.next.includes(option.id)"
          :disabled="!canManage"
          @update:model-value="(v) => toggleNext(option.id, Boolean(v))"
        />
        <span class="min-w-0 truncate text-xs">{{ option.title || option.id }}</span>
        <span class="text-muted-foreground shrink-0 text-[10px]">{{ stepKind(option.kind)?.label }}</span>
      </label>
    </div>
  </div>
</template>
