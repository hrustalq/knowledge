<script setup lang="ts">
// The scrolling half of the chat: a virtualized transcript that stays pinned
// to the newest turn.
//
// Rows are wildly variable in height — a one-line question, a page of
// markdown, an embedded graph — so this uses @tanstack/vue-virtual's dynamic
// measurement (ResizeObserver per rendered row) rather than the fixed-height
// virtualizer the project rail uses. An estimate only has to be close enough
// to size the scrollbar before a row has been seen once.
//
// Pinning is conditional, and that condition is the whole difference between
// a chat that follows the conversation and one that yanks you away from
// something you were reading: it auto-scrolls only while you are already at
// the bottom. Scroll up and the stream keeps running without moving you;
// a button offers the way back.
import { computed, nextTick, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { ArrowDown, Sparkles } from 'lucide-vue-next'
import type { AssistantMessageInfo } from '@knowledge/contracts'
import type { LiveTurn } from '@/stores/assistant'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import MarkdownView from '@/components/knowledge/MarkdownView.vue'
import GenerativeUiBlock from '@/components/knowledge/GenerativeUiBlock.vue'
import ChatMessage from './ChatMessage.vue'
import AssistantPrompt from './AssistantPrompt.vue'
import ThinkingTrail from './ThinkingTrail.vue'

const props = defineProps<{
  messages: AssistantMessageInfo[]
  live: LiveTurn | null
  loading: boolean
  error: string | null
  /** Identity of the open thread — a change resets the scroll position. */
  threadId: string | null
}>()

const emit = defineEmits<{ answer: [string]; switchMode: [string] }>()

const scrollEl = ref<HTMLElement | null>(null)
/** Distance from the bottom still counted as "following along". */
const PIN_THRESHOLD = 96
const pinned = ref(true)

/**
 * Virtual rows: every message, plus a trailing row for the turn in flight.
 * The live turn is a row like any other so it is measured, scrolled to, and
 * recycled by the same machinery — no parallel layout path to keep in sync.
 */
type Row = { kind: 'message'; message: AssistantMessageInfo } | { kind: 'live'; live: LiveTurn }

const rows = computed<Row[]>(() => [
  ...props.messages.map((message) => ({ kind: 'message' as const, message })),
  ...(props.live ? [{ kind: 'live' as const, live: props.live }] : []),
])

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollEl.value,
    // Roughly a three-line answer: overshooting makes the scrollbar jump
    // inward as rows measure, undershooting makes it jump outward.
    estimateSize: () => 132,
    overscan: 6,
    // Keyed by message id so measurements survive a list that grows at the
    // end (and the live row, which is the only one that changes height while
    // it is on screen).
    getItemKey: (index: number) => {
      const row = rows.value[index]
      return row?.kind === 'live' ? 'live' : (row?.message.id ?? index)
    },
  })),
)

const items = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())

/** Narrowed row accessor — the template cannot discriminate a union inline. */
function messageAt(index: number): AssistantMessageInfo | null {
  const row = rows.value[index]
  return row?.kind === 'message' ? row.message : null
}

/**
 * The user turn that answered a prompt: the message right after it, when that
 * message is the user's. The selection lives nowhere else — see AssistantPrompt.
 */
function answerFor(index: number): string | undefined {
  const next = rows.value[index + 1]
  if (next?.kind !== 'message' || next.message.role !== 'user') return undefined
  return next.message.content
}

/** A prompt is answerable only on the last message, and only between turns. */
function isNewest(index: number): boolean {
  return !props.live && index === props.messages.length - 1
}

/** Vue hands template refs `Element | ComponentPublicInstance`; the virtualizer wants an Element. */
function measure(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof Element) virtualizer.value.measureElement(el)
}

function atBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_THRESHOLD
}

/**
 * Scrolls we caused ourselves, which must not be read as the reader
 * scrolling away.
 *
 * This is the whole subtlety of pinning a virtualized transcript. Rows are
 * measured after they paint, so a long answer's real height only lands a
 * frame or two later — and until it does, "scrolled to the bottom" quietly
 * becomes "800px from the bottom" with no input from anyone. Deriving the pin
 * from the raw scroll position alone drops it on the first tall reply and
 * again on every token while streaming. The window is time-based rather than
 * one frame because a scroll event can arrive several frames after the write
 * that caused it.
 */
const PROGRAMMATIC_WINDOW_MS = 150
/** Longest a thread may spend re-aiming at its own bottom before it gives up. */
const SETTLE_MAX_MS = 800
/** Frames of an unchanged measured total that count as "the rows have settled". */
const SETTLE_STABLE_FRAMES = 3
let programmaticUntil = 0

function jumpToBottom(el: HTMLElement, behavior: ScrollBehavior) {
  programmaticUntil = performance.now() + PROGRAMMATIC_WINDOW_MS
  el.scrollTo({ top: el.scrollHeight, behavior })
}

function onScroll() {
  if (performance.now() < programmaticUntil) return
  const el = scrollEl.value
  if (el) pinned.value = atBottom(el)
}

function scrollToEnd(behavior: ScrollBehavior = 'smooth') {
  const el = scrollEl.value
  if (!el) return
  pinned.value = true
  jumpToBottom(el, behavior)
}

/** Follow the tail while the reader is following it. */
async function followTail() {
  if (!pinned.value) return
  await nextTick()
  const el = scrollEl.value
  if (el) jumpToBottom(el, 'auto')
}

/**
 * Re-aims at the bottom for a few frames after a thread opens.
 *
 * One scroll is not enough: the rows have not been measured yet, so the
 * scrollport is still sized from the 132px estimate and "the bottom" is
 * hundreds of pixels short of where it ends up. Re-aiming for a bounded burst
 * of frames rides the measurements in. Bounded is the point — following the
 * measured total indefinitely feeds the ResizeObserver back into itself and
 * the transcript stops answering the scroll wheel at all.
 */
function settleToBottom() {
  const deadline = performance.now() + SETTLE_MAX_MS
  let lastHeight = -1
  let stableFrames = 0
  const step = () => {
    const el = scrollEl.value
    if (!el || !pinned.value) return
    jumpToBottom(el, 'auto')
    stableFrames = el.scrollHeight === lastHeight ? stableFrames + 1 : 0
    lastHeight = el.scrollHeight
    // Stop as soon as the measured total holds still — or at the deadline,
    // so a pathological re-measure loop cannot pin the scroller forever.
    if (stableFrames >= SETTLE_STABLE_FRAMES || performance.now() > deadline) return
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

watch(() => props.messages.length, () => void followTail())
// The live row grows on every token, so its measured height is what actually
// moves the tail — watching the text is what keeps the caret in view.
watch(() => props.live?.text.length ?? 0, () => void followTail())
watch(() => props.live?.steps.length ?? 0, () => void followTail())
watch(
  () => props.threadId,
  () => {
    pinned.value = true
    void nextTick(settleToBottom)
  },
)

onMounted(() => {
  pinned.value = true
  void nextTick(settleToBottom)
})

defineExpose({ scrollToEnd })
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div
      ref="scrollEl"
      class="quiet-scroll h-full overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
    >
      <div class="mx-auto w-full max-w-4xl px-4 py-6 lg:px-8">
        <!-- Loading a thread: shaped placeholders, not a spinner over nothing. -->
        <div v-if="loading" class="space-y-6" aria-hidden="true">
          <div class="flex justify-end"><Skeleton class="h-10 w-64 rounded-2xl" /></div>
          <div class="flex gap-3">
            <Skeleton class="size-6 shrink-0 rounded-full" />
            <div class="min-w-0 flex-1 space-y-2">
              <Skeleton class="h-4 w-full max-w-[36rem]" />
              <Skeleton class="h-4 w-full max-w-[30rem]" />
              <Skeleton class="h-4 w-2/3 max-w-[22rem]" />
            </div>
          </div>
        </div>

        <!-- Empty state that teaches the two modes rather than saying "no messages". -->
        <div v-else-if="rows.length === 0" class="flex min-h-[24rem] flex-col justify-center py-10">
          <span
            class="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
            aria-hidden="true"
          >
            <Sparkles class="size-4.5" />
          </span>
          <h2 class="mt-4 font-display text-xl font-semibold tracking-tight">Ask the knowledge base</h2>
          <p class="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
            Questions are answered from the pages in this workspace, with the sources it used listed under every
            reply. In <strong class="font-medium text-foreground">Agent</strong> mode it can also write: a new page
            goes live immediately, a change to an existing page opens a merge request for you to review first.
          </p>
          <ul class="mt-5 space-y-1.5 text-sm text-muted-foreground">
            <li>“How does session revocation work on password reset?”</li>
            <li>“Summarize everything we have on the ingestion pipeline.”</li>
            <li>“Draft an onboarding page for new backend hires.”</li>
          </ul>
        </div>

        <!-- The transcript. Absolute rows inside a spacer sized to the total. -->
        <div v-else class="relative w-full" :style="{ height: `${totalSize}px` }">
          <div
            v-for="item in items"
            :key="String(item.key)"
            :ref="measure"
            :data-index="item.index"
            class="absolute top-0 left-0 w-full pb-6"
            :style="{ transform: `translateY(${item.start}px)` }"
          >
            <template v-if="messageAt(item.index)">
              <ChatMessage
                :message="messageAt(item.index)!"
                :prompt-active="isNewest(item.index)"
                :prompt-answer="answerFor(item.index)"
                @answer="emit('answer', $event)"
                @switch-mode="emit('switchMode', $event)"
              />
            </template>
            <template v-else-if="live">
              <div class="flex gap-3">
                <span
                  class="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary ring-1 ring-primary/15"
                  aria-hidden="true"
                >
                  <Sparkles class="size-3.5" />
                </span>
                <div class="min-w-0 flex-1 space-y-3">
                  <ThinkingTrail :live="live!" />
                  <MarkdownView
                    v-if="live!.text"
                    :markdown="live!.text"
                    :streaming="!live!.stopped"
                    class="max-w-[72ch]"
                  />
                  <GenerativeUiBlock v-for="(block, i) in live!.uiBlocks" :key="i" :block="block" />
                  <!-- Shown as soon as it is built, but inert until the turn
                       ends: answering a question the assistant is still
                       finishing would race its own last sentence. -->
                  <AssistantPrompt
                    v-if="live!.prompt"
                    :prompt="live!.prompt"
                    :active="false"
                    class="max-w-[42rem]"
                  />
                </div>
              </div>
            </template>
          </div>
        </div>

        <p v-if="error" class="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {{ error }}
        </p>
      </div>
    </div>

    <!-- Only offered when it is actually needed: you have scrolled away. -->
    <Transition
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      leave-active-class="transition duration-150 ease-in"
      leave-to-class="translate-y-2 opacity-0"
    >
      <Button
        v-if="!pinned && rows.length > 0"
        variant="outline"
        size="sm"
        class="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full shadow-md backdrop-blur-lg"
        @click="scrollToEnd()"
      >
        <ArrowDown class="size-3.5" />
        Jump to latest
      </Button>
    </Transition>
  </div>
</template>
