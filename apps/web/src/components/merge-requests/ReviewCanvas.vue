<script setup lang="ts">
/**
 * Review mode (docs/features/13): the merge request's page as a reader sees
 * it, annotated like a PDF or a Figma frame.
 *
 * A diff answers "what changed"; it does not answer "does this read well". So
 * this renders the source-head revision through the ordinary page renderer —
 * tables, panels, diagrams and all — and puts commenting on top of it:
 * select a passage to start a thread, and every commented passage stays
 * highlighted with the discussion one click away.
 *
 * The floating layer is absolutely positioned against this component rather
 * than the viewport, so it scrolls with the passage it belongs to. It is
 * marked `data-kn-anno-ui` so the anchor projection skips its text — comment
 * bodies are not part of the page being reviewed.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { MessageSquarePlus, X } from 'lucide-vue-next'
import type { MergeRequestThread, MergeRequestThreadAnchor } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import ThreadCard from './ThreadCard.vue'
import CommentComposer from './CommentComposer.vue'
import { anchorFromSelection, highlightThreads, threadsAtEvent, type TextAnchor } from './text-anchor'

const props = withDefaults(
  defineProps<{
    markdown: string
    /** Revision the anchors are recorded against (the MR's source head). */
    revisionId: string
    threads: MergeRequestThread[]
    canComment?: boolean
    busy?: boolean
    resolveDocumentId?: () => Promise<string | null>
  }>(),
  { canComment: false, busy: false, resolveDocumentId: undefined },
)

const emit = defineEmits<{
  'create-thread': [body: string, anchor?: MergeRequestThreadAnchor]
  reply: [threadId: string, body: string]
  resolve: [threadId: string, resolved: boolean]
  /** Anchored threads whose passage no longer exists on the page. */
  outdated: [threadIds: string[]]
}>()

interface Floater {
  top: number
  left: number
}

const canvas = ref<HTMLElement | null>(null)
const page = ref<HTMLElement | null>(null)

/** Where the "Comment" affordance sits while a selection is live. */
const selectionAt = ref<Floater | null>(null)
const pendingAnchor = ref<TextAnchor | null>(null)

/** The open discussion popover: which threads, and where. */
const openThreadIds = ref<string[]>([])
const popoverAt = ref<Floater | null>(null)

const byId = computed(() => new Map(props.threads.map((t) => [t.threadId, t])))
const openThreads = computed(() =>
  openThreadIds.value.map((id) => byId.value.get(id)).filter((t): t is MergeRequestThread => !!t),
)
const anchoredCount = computed(
  () => props.threads.filter((t) => t.anchor?.type === 'text').length,
)

/** Viewport rect → coordinates inside the (scrolling) canvas. */
function toCanvas(rect: DOMRect): Floater | null {
  const host = canvas.value
  if (!host) return null
  const base = host.getBoundingClientRect()
  return { top: rect.bottom - base.top + 6, left: Math.max(0, rect.left - base.left) }
}

function applyHighlights() {
  const root = page.value
  if (!root) return
  const { outdated } = highlightThreads(root, props.threads)
  emit('outdated', outdated)
  // A thread whose passage vanished cannot keep a popover open over nothing.
  openThreadIds.value = openThreadIds.value.filter((id) => !outdated.includes(id))
  if (openThreadIds.value.length === 0) popoverAt.value = null
}

function onRendered(root: HTMLElement) {
  page.value = root
  applyHighlights()
}

/**
 * Selection is read on mouse/key release rather than on every `selectionchange`
 * — mid-drag the range is still moving, and an affordance that jumps around
 * under the cursor is worse than one that appears when the drag ends.
 */
function readSelection() {
  if (!props.canComment || !page.value || pendingAnchor.value) return
  const anchor = anchorFromSelection(page.value, props.revisionId)
  if (!anchor) {
    selectionAt.value = null
    return
  }
  const selection = window.getSelection()
  const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null
  selectionAt.value = rect && rect.width + rect.height > 0 ? toCanvas(rect) : null
}

function startThread() {
  if (!page.value) return
  const anchor = anchorFromSelection(page.value, props.revisionId)
  if (!anchor) return
  pendingAnchor.value = anchor
  popoverAt.value = selectionAt.value
  openThreadIds.value = []
  selectionAt.value = null
  window.getSelection()?.removeAllRanges()
}

function onPageClick(event: MouseEvent) {
  const ids = threadsAtEvent(event.target)
  if (ids.length === 0) return
  // A highlight is a control, not a link: clicking one opens its discussion
  // rather than following the surrounding prose's link, if any.
  event.preventDefault()
  const mark = (event.target as Element).closest('mark')
  openThreadIds.value = ids
  pendingAnchor.value = null
  popoverAt.value = mark ? toCanvas(mark.getBoundingClientRect()) : null
}

function onPageKeydown(event: KeyboardEvent) {
  if (event.key !== 'Enter' && event.key !== ' ') return
  const ids = threadsAtEvent(event.target)
  if (ids.length === 0) return
  event.preventDefault()
  const mark = (event.target as Element).closest('mark')
  openThreadIds.value = ids
  pendingAnchor.value = null
  popoverAt.value = mark ? toCanvas(mark.getBoundingClientRect()) : null
}

function closePopover() {
  openThreadIds.value = []
  pendingAnchor.value = null
  popoverAt.value = null
}

function submitNewThread(body: string) {
  emit('create-thread', body, pendingAnchor.value ?? undefined)
  closePopover()
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') closePopover()
}

onMounted(() => document.addEventListener('keydown', onDocumentKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onDocumentKeydown))

// Resolving a thread recolors its highlight, and a new one has to be placed —
// both mean re-running the whole pass over the freshly rendered page.
watch(() => props.threads, applyHighlights, { deep: true })
</script>

<template>
  <div ref="canvas" class="relative" @mouseup="readSelection" @keyup="readSelection">
    <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <template v-if="canComment">
        <MessageSquarePlus class="size-3.5" />
        Select any passage to comment on it.
      </template>
      <span v-else>Read-only — commenting needs the editor role on an open merge request.</span>
      <span v-if="anchoredCount" class="ml-auto">
        {{ anchoredCount }} anchored comment{{ anchoredCount === 1 ? '' : 's' }}
      </span>
    </div>

    <article class="rounded-lg border bg-card px-5 py-4" @click="onPageClick" @keydown="onPageKeydown">
      <MarkdownView glossary :markdown="markdown" @rendered="onRendered" />
    </article>

    <!-- Floating "comment on this" affordance, anchored to the live selection -->
    <div
      v-if="selectionAt && canComment"
      data-kn-anno-ui
      class="absolute z-20"
      :style="{ top: `${selectionAt.top}px`, left: `${selectionAt.left}px` }"
    >
      <Button size="xs" class="shadow-md" @mousedown.prevent @click="startThread">
        <MessageSquarePlus class="size-3.5" /> Comment
      </Button>
    </div>

    <!-- Discussion popover: an open thread, or the composer for a new one -->
    <div
      v-if="popoverAt && (openThreads.length || pendingAnchor)"
      data-kn-anno-ui
      class="absolute z-30 w-[min(28rem,calc(100%-1rem))] space-y-2 rounded-lg border bg-popover p-2 shadow-lg"
      :style="{ top: `${popoverAt.top}px`, left: `${popoverAt.left}px` }"
    >
      <div class="flex items-start gap-2">
        <p v-if="pendingAnchor" class="min-w-0 flex-1 text-xs text-muted-foreground">
          New comment on “<span class="italic">{{ pendingAnchor.quote.slice(0, 90) }}</span
          >{{ pendingAnchor.quote.length > 90 ? '…' : '' }}”
        </p>
        <p v-else class="min-w-0 flex-1 text-xs text-muted-foreground">
          {{ openThreads.length }} thread{{ openThreads.length === 1 ? '' : 's' }} on this passage
        </p>
        <button
          class="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
          aria-label="Close"
          @click="closePopover"
        >
          <X class="size-3.5" />
        </button>
      </div>

      <CommentComposer
        v-if="pendingAnchor"
        auto-expand
        placeholder="Write a comment…"
        submit-label="Start thread"
        :busy="busy"
        :resolve-document-id="resolveDocumentId"
        @submit="submitNewThread"
      />

      <div v-else class="max-h-[26rem] space-y-2 overflow-y-auto">
        <ThreadCard
          v-for="thread in openThreads"
          :key="thread.threadId"
          :thread="thread"
          :readonly="!canComment"
          :busy="busy"
          :resolve-document-id="resolveDocumentId"
          @reply="(b: string) => emit('reply', thread.threadId, b)"
          @resolve="(r: boolean) => emit('resolve', thread.threadId, r)"
        />
      </div>
    </div>
  </div>
</template>
