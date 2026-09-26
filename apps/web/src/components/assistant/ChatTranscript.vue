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
// something you were reading: it follows the tail only while you are still
// reading the tail. Scroll up and the stream keeps running without moving you;
// a button offers the way back.
//
// Following is treated as a mode the reader owns rather than as a reading of
// where the scrollbar sits, because in a transcript that measures itself the
// scrollbar moves constantly with no input from anyone. The two mechanisms
// below — a tail key that survives the end of a turn, and one observer that
// re-aims on any size change — are what let that hold.
import { useI18n } from 'vue-i18n'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
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

const { t } = useI18n()

const props = defineProps<{
  messages: AssistantMessageInfo[]
  live: LiveTurn | null
  loading: boolean
  error: string | null
  /** Identity of the open thread — a change resets the scroll position. */
  threadId: string | null
}>()

const emit = defineEmits<{
  answer: [string]
  switchMode: [string]
  reset: [AssistantMessageInfo]
  edit: [{ message: AssistantMessageInfo; content: string }]
}>()

const scrollEl = ref<HTMLElement | null>(null)
/** Everything inside the scrollport. Its height is what actually moves the tail. */
const contentEl = ref<HTMLElement | null>(null)
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

/**
 * The tail row keeps one virtualizer key for the whole turn — while it streams,
 * and after it lands as a persisted message.
 *
 * This is what stops the lurch at the end of a stream. Measurements are cached
 * per key, and the `done` frame swaps the live row for a message row in a
 * single tick without changing the row count. Keying that message by its id
 * makes the swap a cache miss: a measured 1200px answer becomes the 132px
 * estimate for one frame, the content collapses by the difference, the browser
 * clamps scrollTop to the now-shorter page, and the reader is thrown up to
 * wherever the clamp landed — the top of the reply for a long answer, just
 * above it for a short one. Holding the key steady instead lets Vue patch the
 * same row element in place, so its height moves continuously and there is
 * nothing to clamp.
 *
 * The key rotates per turn rather than being the literal string 'live', so the
 * message that inherits it keeps it for good without colliding with the next
 * turn's live row.
 */
let turnSeq = 0
const liveKey = ref<string | null>(null)
/** The message that inherited the live row's key when its turn landed. */
const tailOwner = ref<{ id: string; key: string } | null>(null)

watch(
  () => props.live !== null,
  (streaming) => {
    if (streaming) {
      turnSeq += 1
      liveKey.value = `turn-${turnSeq}`
      return
    }
    // The turn ended, so whatever is last now is the message that row became.
    // Both endings arrive here — `done` pushing the reply, and a stopped turn
    // re-read from the server — so neither needs its own case.
    const last = props.messages.at(-1)
    if (last && liveKey.value) tailOwner.value = { id: last.id, key: liveKey.value }
    liveKey.value = null
  },
  // Synchronous: the key has to be settled before the render that drops the
  // live row, or the swap is a cache miss after all.
  { flush: 'sync', immediate: true },
)

const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollEl.value,
    // Roughly a three-line answer: overshooting makes the scrollbar jump
    // inward as rows measure, undershooting makes it jump outward.
    estimateSize: () => 132,
    overscan: 6,
    // Keyed so measurements survive a list that grows at the end, and so the
    // tail keeps its measured height across the live → persisted handoff.
    getItemKey: (index: number) => {
      const row = rows.value[index]
      if (!row) return index
      if (row.kind === 'live') return liveKey.value ?? 'live'
      const owner = tailOwner.value
      return owner?.id === row.message.id ? owner.key : row.message.id
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
 * Releasing the pin is something the reader does, not something the layout
 * does.
 *
 * Deriving it from scroll position looks equivalent and is not: rows are
 * measured after they paint, so the scrollport resizes under a viewport nobody
 * touched — on every token, on the markdown passes that only run once the text
 * stops arriving, on a diagram that resolves its import half a second later.
 * Position-derived pinning reads each of those as the reader walking away and
 * quietly stops following. Taking intent as the input instead means layout
 * never gets a vote, which is the entire fix for a transcript that measures
 * itself.
 *
 * A flick that never clears the threshold is not a decision to stop following;
 * `onScroll` takes the pin straight back on the next frame.
 */
function releasePin() {
  pinned.value = false
}

function onWheel(e: WheelEvent) {
  if (e.deltaY < 0) releasePin()
}

let touchY = 0
function onTouchStart(e: TouchEvent) {
  touchY = e.touches[0]?.clientY ?? 0
}
function onTouchMove(e: TouchEvent) {
  const y = e.touches[0]?.clientY ?? 0
  // Dragging the content downward means travelling up the transcript.
  if (y > touchY + 2) releasePin()
  touchY = y
}

/**
 * The scrollbar and the keyboard are the ways up that fire no gesture we can
 * name, so position still gets a vote — but only across a scrollport that held
 * still. A scroll that arrives together with a height change is the transcript
 * re-laying out beneath a stationary reader, which is the exact event the old
 * position-derived pin mistook for walking away.
 */
let lastScrollHeight = 0
function onScroll() {
  const el = scrollEl.value
  if (!el) return
  const resized = el.scrollHeight !== lastScrollHeight
  lastScrollHeight = el.scrollHeight
  if (atBottom(el)) pinned.value = true
  else if (!resized) pinned.value = false
}

/** Glue the viewport to the tail. Never animated — a stream has to keep up with tokens. */
function stickToBottom() {
  const el = scrollEl.value
  if (!el || !pinned.value) return
  el.scrollTop = el.scrollHeight
  lastScrollHeight = el.scrollHeight
}

/** Instant by default; the jump button is the one caller that animates. */
function scrollToEnd(behavior: ScrollBehavior = 'auto') {
  const el = scrollEl.value
  if (!el) return
  pinned.value = true
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (behavior === 'smooth' && !reduced) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  else stickToBottom()
}

/**
 * One observer in place of every timer this used to run.
 *
 * Everything that moves the tail is a size change somewhere in the scrollport:
 * a token landing, the live row becoming a persisted message, the markdown
 * passes deferred until the text stopped arriving, a mermaid diagram resolving
 * its dynamic import, or the composer growing a line and taking the
 * scrollport's height with it. Watching for the size change catches all of
 * them and needs no deadline — where a bounded frame burst had to guess how
 * long settling takes, and guessed wrong for anything that loaded
 * asynchronously.
 *
 * Writing scrollTop cannot change scrollHeight, so this does not re-enter.
 */
let resizeObserver: ResizeObserver | null = null

onMounted(() => {
  pinned.value = true
  resizeObserver = new ResizeObserver(() => stickToBottom())
  if (scrollEl.value) resizeObserver.observe(scrollEl.value)
  if (contentEl.value) resizeObserver.observe(contentEl.value)
  stickToBottom()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  resizeObserver = null
})

watch(
  () => props.threadId,
  () => {
    pinned.value = true
    // A different thread's messages never streamed here, so nothing owns the tail key.
    tailOwner.value = null
    void nextTick(stickToBottom)
  },
)

defineExpose({ scrollToEnd })
</script>

<template>
  <div class="relative min-h-0 flex-1">
    <div
      ref="scrollEl"
      class="quiet-scroll h-full overflow-y-auto overscroll-contain"
      @scroll.passive="onScroll"
      @wheel.passive="onWheel"
      @touchstart.passive="onTouchStart"
      @touchmove.passive="onTouchMove"
    >
      <div ref="contentEl" class="mx-auto w-full max-w-4xl px-4 py-6 @3xl:px-8">
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
        <slot v-else-if="rows.length === 0 && $slots.empty" name="empty" />
        <div v-else-if="rows.length === 0" class="flex min-h-[24rem] flex-col justify-center py-10">
          <span
            class="flex size-9 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/15"
            aria-hidden="true"
          >
            <Sparkles class="size-4.5" />
          </span>
          <h2 class="mt-4 font-display text-xl font-semibold tracking-tight">{{ t('chat.askKnowledgeBase') }}</h2>
          <p class="mt-1.5 max-w-prose text-sm leading-relaxed text-muted-foreground">
            {{ t('chat.emptyBodyBefore') }}
            <strong class="font-medium text-foreground">{{ t('chat.modeAgent') }}</strong>
            {{ t('chat.emptyBodyAfter') }}
          </p>
          <ul class="mt-5 space-y-1.5 text-sm text-muted-foreground">
            <li>{{ t('chat.example1') }}</li>
            <li>{{ t('chat.example2') }}</li>
            <li>{{ t('chat.example3') }}</li>
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
                :actionable="!live"
                @answer="emit('answer', $event)"
                @switch-mode="emit('switchMode', $event)"
                @reset="emit('reset', $event)"
                @edit="emit('edit', $event)"
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
        @click="scrollToEnd('smooth')"
      >
        <ArrowDown class="size-3.5" />
        {{ t('chat.jumpToLatest') }}
      </Button>
    </Transition>
  </div>
</template>
