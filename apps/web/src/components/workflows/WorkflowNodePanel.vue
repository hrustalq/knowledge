<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { Check, ExternalLink, RotateCcw, SkipForward, X } from 'lucide-vue-next'
import type {
  WorkflowGraph,
  WorkflowNodeEventType,
  WorkflowRunNodeInfo,
} from '@knowledge/contracts'
import { allowedNodeEvents } from '@knowledge/workflow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { isBusyStatus, NODE_STATUS_CLASS, NODE_STATUS_ICON, NODE_STATUS_LABEL } from './workflow-ui'

/**
 * One node's draft, and the review gate over it (docs/features/17).
 *
 * The buttons come from `allowedNodeEvents` — the same compiled machine the API
 * will consult before accepting the event. That is the point of the shared
 * package: the reviewer is never offered an action that will 409.
 */
const props = defineProps<{
  node: WorkflowRunNodeInfo
  graph: WorkflowGraph
  canEdit: boolean
  busy: boolean
}>()

const emit = defineEmits<{
  event: [WorkflowNodeEventType, { title: string; markdown: string } | undefined]
  save: [{ title: string; markdown: string }]
}>()

const step = computed(() => props.graph.steps.find((s) => s.id === props.node.stepId) ?? null)

const editing = ref(false)
const title = ref('')
const markdown = ref('')

watch(
  () => props.node.id,
  () => {
    editing.value = false
    title.value = props.node.draft?.title ?? ''
    markdown.value = props.node.draft?.markdown ?? ''
  },
  { immediate: true },
)

const allowed = computed<WorkflowNodeEventType[]>(() =>
  step.value && props.canEdit ? allowedNodeEvents(step.value, props.node.status) : [],
)
const can = (event: WorkflowNodeEventType) => allowed.value.includes(event)

const edited = computed(
  () => title.value !== (props.node.draft?.title ?? '') || markdown.value !== (props.node.draft?.markdown ?? ''),
)

/** Approving carries the edit, so reviewing and correcting are one action. */
function approve() {
  emit('event', 'APPROVE', edited.value ? { title: title.value, markdown: markdown.value } : undefined)
  editing.value = false
}
</script>

<template>
  <div class="flex min-h-0 flex-col gap-4">
    <header class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <h2 class="truncate text-base font-semibold">
          {{ node.draft?.title || step?.title || node.stepId }}
        </h2>
        <p class="text-muted-foreground mt-0.5 flex items-center gap-1.5 text-xs">
          <component
            :is="NODE_STATUS_ICON[node.status]"
            class="size-3.5"
            :class="[NODE_STATUS_CLASS[node.status], isBusyStatus(node.status) ? 'animate-spin' : '']"
          />
          {{ NODE_STATUS_LABEL[node.status] }}
          <template v-if="step"> · {{ step.title }}</template>
          <template v-if="node.attempt > 0"> · attempt {{ node.attempt + 1 }}</template>
        </p>
      </div>
      <a
        v-if="node.documentId"
        :href="`/documents/${node.documentId}`"
        class="text-primary inline-flex shrink-0 items-center gap-1 text-xs hover:underline"
      >
        Open page <ExternalLink class="size-3" />
      </a>
    </header>

    <p v-if="node.error" class="text-destructive bg-destructive/5 rounded-md border px-3 py-2 text-xs">
      {{ node.error }}
    </p>

    <div v-if="!node.draft" class="text-muted-foreground rounded-md border border-dashed py-10 text-center text-sm">
      <template v-if="node.status === 'pending' || node.status === 'running'">
        This step has not produced anything yet.
      </template>
      <template v-else>Nothing was produced for this step.</template>
    </div>

    <template v-else>
      <div v-if="editing" class="space-y-3">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Title</span>
          <Input v-model="title" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">Body</span>
          <Textarea v-model="markdown" rows="16" class="font-mono text-xs" />
        </label>
        <div class="flex gap-2">
          <Button size="sm" variant="outline" :disabled="!edited" @click="emit('save', { title, markdown })">
            Save draft
          </Button>
          <Button size="sm" variant="ghost" @click="editing = false">Done editing</Button>
        </div>
      </div>

      <div v-else class="min-h-0 overflow-auto">
        <p v-if="node.draft.summary" class="text-muted-foreground mb-3 text-sm">{{ node.draft.summary }}</p>
        <MarkdownView v-if="node.draft.markdown" :markdown="node.draft.markdown" />
        <p v-else class="text-muted-foreground text-sm italic">
          No page body — this item is a heading for the steps below it.
        </p>
      </div>
    </template>

    <footer v-if="allowed.length || node.draft" class="flex flex-wrap items-center gap-2 border-t pt-3">
      <Button v-if="can('APPROVE')" size="sm" :disabled="busy" @click="approve">
        <Check class="mr-1.5 size-4" />
        {{ step?.produces ? 'Approve and publish' : 'Approve' }}
      </Button>
      <Button
        v-if="node.draft && canEdit && !editing && can('APPROVE')"
        size="sm"
        variant="outline"
        @click="editing = true"
      >
        Edit first
      </Button>
      <Button v-if="can('RETRY')" size="sm" variant="outline" :disabled="busy" @click="emit('event', 'RETRY', undefined)">
        <RotateCcw class="mr-1.5 size-4" /> Try again
      </Button>
      <Button
        v-if="can('SKIP')"
        size="sm"
        variant="ghost"
        :disabled="busy"
        @click="emit('event', 'SKIP', undefined)"
      >
        <SkipForward class="mr-1.5 size-4" /> Skip
      </Button>
      <Button
        v-if="can('REJECT')"
        size="sm"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive ml-auto"
        :disabled="busy"
        @click="emit('event', 'REJECT', undefined)"
      >
        <X class="mr-1.5 size-4" /> Reject
      </Button>
    </footer>
  </div>
</template>
