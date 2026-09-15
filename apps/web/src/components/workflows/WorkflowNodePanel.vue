<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { computed, ref, watch } from 'vue'
import { Check, ExternalLink, RotateCcw, SkipForward, X } from 'lucide-vue-next'
import type {
  RelationInput,
  WorkflowGraph,
  WorkflowNodeDraft,
  WorkflowNodeEventType,
  WorkflowRunNodeInfo,
} from '@knowledge/contracts'
import { AUTHORABLE_RELATION_TYPES, isAuthorableRelationType } from '@knowledge/contracts'
import { allowedNodeEvents } from '@knowledge/workflow'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import { isBusyStatus, NODE_STATUS_CLASS, NODE_STATUS_ICON, NODE_STATUS_LABEL } from './workflow-ui'

const { t } = useI18n()

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
  /** The whole run, so a fan-out step can show what it produced. */
  nodes: WorkflowRunNodeInfo[]
  canEdit: boolean
  busy: boolean
}>()

/**
 * The whole draft, not just its prose.
 *
 * A step can now propose the relations and tags its page should declare, and
 * those become deterministic graph facts the moment the page is published — so
 * approving them unseen would be approving a claim about the workspace nobody
 * read. They are shown here, and editable, for the same reason the body is.
 */
const emit = defineEmits<{
  event: [WorkflowNodeEventType, WorkflowNodeDraft | undefined]
  save: [WorkflowNodeDraft]
  select: [string]
}>()

/**
 * A step that broke the source down has no page of its own — its output *is*
 * the cards below it. Saying "nothing was produced" there was true of the
 * draft column and false of the step, which is the worst kind of empty state.
 */
const children = computed(() => props.nodes.filter((n) => n.parentId === props.node.id))

const step = computed(() => props.graph.steps.find((s) => s.id === props.node.stepId) ?? null)

const editing = ref(false)
const title = ref('')
const markdown = ref('')
const relations = ref<RelationInput[]>([])
const tags = ref('')

function readTags(frontmatter?: Record<string, unknown> | null): string[] {
  const raw = frontmatter?.tags
  return Array.isArray(raw) ? raw.filter((tag): tag is string => typeof tag === 'string') : []
}

watch(
  () => props.node.id,
  () => {
    editing.value = false
    title.value = props.node.draft?.title ?? ''
    markdown.value = props.node.draft?.markdown ?? ''
    // Deep-copied, so editing a row does not mutate the query cache in place.
    relations.value = (props.node.draft?.relations ?? []).map((r) => ({ ...r, target: { ...r.target } }))
    tags.value = readTags(props.node.draft?.frontmatter).join(', ')
  },
  { immediate: true },
)

/** What the draft would become — read by both Save and Approve. */
const draftPatch = computed<WorkflowNodeDraft>(() => {
  const tagList = tags.value.split(',').map((tag) => tag.trim()).filter(Boolean)
  // Every other frontmatter key the step produced is carried through untouched.
  const frontmatter = { ...(props.node.draft?.frontmatter ?? {}) }
  if (tagList.length > 0) frontmatter.tags = tagList
  else delete frontmatter.tags

  return {
    title: title.value,
    markdown: markdown.value,
    ...(props.node.draft?.summary ? { summary: props.node.draft.summary } : {}),
    relations: relations.value.filter((r) => r.type && r.target.key.trim()),
    ...(Object.keys(frontmatter).length > 0 ? { frontmatter } : {}),
  }
})

const viewRelations = computed(() => props.node.draft?.relations ?? [])
const viewTags = computed(() => readTags(props.node.draft?.frontmatter))

function addRelation() {
  relations.value.push({ type: 'RELATED_TO', target: { type: 'entity', key: '', name: '' } })
}

function setRelationType(index: number, value: string) {
  const row = relations.value[index]
  // The Select only offers allowed types; the guard is what lets the narrowed
  // contract type hold without a cast.
  if (row && isAuthorableRelationType(value)) row.type = value
}

const allowed = computed<WorkflowNodeEventType[]>(() =>
  step.value && props.canEdit ? allowedNodeEvents(step.value, props.node.status) : [],
)
const can = (event: WorkflowNodeEventType) => allowed.value.includes(event)

const edited = computed(() => {
  const before = props.node.draft
  if (title.value !== (before?.title ?? '')) return true
  if (markdown.value !== (before?.markdown ?? '')) return true
  if (tags.value !== readTags(before?.frontmatter).join(', ')) return true

  const now = draftPatch.value.relations ?? []
  const was = before?.relations ?? []
  if (now.length !== was.length) return true
  return now.some((r, i) => r.type !== was[i]?.type || r.target.key !== was[i]?.target.key)
})

/** Approving carries the edit, so reviewing and correcting are one action. */
function approve() {
  emit('event', 'APPROVE', edited.value ? draftPatch.value : undefined)
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
          {{ t(NODE_STATUS_LABEL[node.status]) }}
          <template v-if="step"> · {{ step.title }}</template>
          <template v-if="node.attempt > 0"> · {{ t('workflow.node.attempt', { n: node.attempt + 1 }) }}</template>
        </p>
      </div>
      <a
        v-if="node.documentId"
        :href="`/documents/${node.documentId}`"
        class="text-primary inline-flex shrink-0 items-center gap-1 text-xs hover:underline"
      >
        {{ t('workflow.node.openPage') }} <ExternalLink class="size-3" />
      </a>
    </header>

    <p v-if="node.error" class="text-destructive bg-destructive/5 rounded-md border px-3 py-2 text-xs">
      {{ node.error }}
    </p>

    <div v-if="children.length" class="space-y-2">
      <p class="text-muted-foreground text-xs">
        {{ t('workflow.brokeIntoItems', { items: t('count.items', { n: children.length }, children.length) }) }}
      </p>
      <ul class="divide-y overflow-hidden rounded-md border">
        <li v-for="child in children" :key="child.id">
          <button
            type="button"
            class="hover:bg-muted/40 focus-visible:ring-ring flex w-full items-start gap-2 px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:-outline-offset-2"
            @click="emit('select', child.id)"
          >
            <component
              :is="NODE_STATUS_ICON[child.status]"
              class="mt-0.5 size-3.5 shrink-0"
              :class="[NODE_STATUS_CLASS[child.status], isBusyStatus(child.status) ? 'animate-spin' : '']"
            />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-[13px]">{{ child.draft?.title ?? t('workflow.node.untitled') }}</span>
              <span class="text-muted-foreground block truncate text-[11px]">
                {{ child.draft?.summary || t(NODE_STATUS_LABEL[child.status]) }}
              </span>
            </span>
          </button>
        </li>
      </ul>
    </div>

    <div
      v-else-if="!node.draft"
      class="text-muted-foreground rounded-md border border-dashed py-10 text-center text-sm"
    >
      <template v-if="node.status === 'pending' || node.status === 'running'">
        {{ t('workflow.node.working') }}
      </template>
      <template v-else>{{ t('workflow.node.passedAlong') }}</template>
    </div>

    <template v-else-if="node.draft">
      <div v-if="editing" class="space-y-3">
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.node.title') }}</span>
          <Input v-model="title" />
        </label>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.node.body') }}</span>
          <Textarea v-model="markdown" rows="16" class="font-mono text-xs" />
        </label>
        <div class="space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.node.relations') }}</span>
          <p class="text-muted-foreground text-[11px]">{{ t('workflow.node.relationsHint') }}</p>
          <div v-for="(row, i) in relations" :key="i" class="flex items-center gap-2">
            <Select :model-value="row.type" @update:model-value="(v) => setRelationType(i, String(v))">
              <SelectTrigger class="h-9 w-[11rem] shrink-0 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem v-for="r in AUTHORABLE_RELATION_TYPES" :key="r" :value="r">{{ r }}</SelectItem>
              </SelectContent>
            </Select>
            <Input
              v-model="row.target.key"
              class="min-w-0 flex-1 text-xs"
              :placeholder="t('workflow.node.relationTargetPlaceholder')"
            />
            <Button
              size="sm"
              variant="ghost"
              :aria-label="t('workflow.node.removeRelation')"
              @click="relations.splice(i, 1)"
            >
              <X class="size-4" />
            </Button>
          </div>
          <Button size="sm" variant="outline" @click="addRelation">{{ t('workflow.node.addRelation') }}</Button>
        </div>
        <label class="block space-y-1.5">
          <span class="text-muted-foreground text-xs font-medium">{{ t('workflow.node.tags') }}</span>
          <Input v-model="tags" :placeholder="t('workflow.node.tagsPlaceholder')" />
        </label>
        <div class="flex gap-2">
          <Button size="sm" variant="outline" :disabled="!edited" @click="emit('save', draftPatch)">
            {{ t('workflow.node.saveDraft') }}
          </Button>
          <Button size="sm" variant="ghost" @click="editing = false">{{ t('workflow.node.doneEditing') }}</Button>
        </div>
      </div>

      <div v-else class="min-h-0 overflow-auto">
        <p v-if="node.draft.summary" class="text-muted-foreground mb-3 text-sm">{{ node.draft.summary }}</p>
        <!-- Relations become graph facts on publication, so they are shown
             beside the prose rather than approved sight-unseen. -->
        <div v-if="viewRelations.length || viewTags.length" class="mb-3 flex flex-wrap gap-1.5">
          <span
            v-for="(r, i) in viewRelations"
            :key="`r-${i}`"
            class="bg-muted/60 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
          >
            <span class="font-medium">{{ r.type }}</span>
            <span class="text-muted-foreground">{{ r.target.key }}</span>
          </span>
          <span
            v-for="tag in viewTags"
            :key="`t-${tag}`"
            class="text-muted-foreground rounded border px-1.5 py-0.5 text-[11px]"
          >
            #{{ tag }}
          </span>
        </div>
        <MarkdownView v-if="node.draft.markdown" :markdown="node.draft.markdown" />
        <p v-else class="text-muted-foreground text-sm italic">
          {{ t('workflow.node.noBody') }}
        </p>
      </div>
    </template>

    <footer v-if="allowed.length || node.draft" class="flex flex-wrap items-center gap-2 border-t pt-3">
      <Button v-if="can('APPROVE')" size="sm" :disabled="busy" @click="approve">
        <Check class="mr-1.5 size-4" />
        {{ step?.produces ? t('workflow.node.approveAndPublish') : t('workflow.node.approve') }}
      </Button>
      <Button
        v-if="node.draft && canEdit && !editing && can('APPROVE')"
        size="sm"
        variant="outline"
        @click="editing = true"
      >
        {{ t('workflow.node.editFirst') }}
      </Button>
      <Button v-if="can('RETRY')" size="sm" variant="outline" :disabled="busy" @click="emit('event', 'RETRY', undefined)">
        <RotateCcw class="mr-1.5 size-4" /> {{ t('workflow.node.tryAgain') }}
      </Button>
      <Button
        v-if="can('SKIP')"
        size="sm"
        variant="ghost"
        :disabled="busy"
        @click="emit('event', 'SKIP', undefined)"
      >
        <SkipForward class="mr-1.5 size-4" /> {{ t('workflow.node.skip') }}
      </Button>
      <Button
        v-if="can('REJECT')"
        size="sm"
        variant="ghost"
        class="text-muted-foreground hover:text-destructive ml-auto"
        :disabled="busy"
        @click="emit('event', 'REJECT', undefined)"
      >
        <X class="mr-1.5 size-4" /> {{ t('workflow.node.reject') }}
      </Button>
    </footer>
  </div>
</template>
