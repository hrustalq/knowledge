<script setup lang="ts">
// The merge-request timeline: state changes and review threads in one
// chronological stream, the way GitLab's overview reads.
//
// Two sources, one list. System notes come from the activity log filtered by
// `subjectId` (the merge request id); threads come from the page, which
// already owns them for the inline diff comments. Sorting them together is
// the whole point — an approval that landed between two comments belongs
// between those two comments, not in a separate panel.
//
// Virtualized against the PAGE scroller rather than a box of its own. A feed
// with its own overflow would put a second scrollbar in the middle of the
// reading column, next to a sticky rail that also scrolls; three scroll
// regions on one screen is how a page stops feeling like a page. The recipe
// is @tanstack/vue-virtual's `scrollMargin`: the virtualizer measures against
// <main>, offset by how far down <main> this list starts.
import { useI18n } from 'vue-i18n'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { MessageSquare } from 'lucide-vue-next'
import type {
  ActivityEntry,
  ListActivityResponse,
  MergeRequestThread,
} from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { useEventsStore } from '@/stores/events'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import ThreadCard from './ThreadCard.vue'
import CommentComposer from './CommentComposer.vue'
import { useMembers } from './use-members'
import { systemNote } from './mr-activity'
import { fullTime, timelineTime } from './mr-ui'

const { t } = useI18n()

const props = defineProps<{
  mergeRequestId: string
  documentId: string
  threads: MergeRequestThread[]
  /** Threads whose diff anchor no longer matches — surfaced on the card. */
  outdatedIds: Set<string>
  readonly?: boolean
  busy?: boolean
}>()

const emit = defineEmits<{
  reply: [threadId: string, body: string, replyToId: string | null]
  resolve: [threadId: string, resolved: boolean]
  edit: [threadId: string, commentId: string, body: string]
  delete: [threadId: string, commentId: string]
  /** `resolvable`: GitLab's Comment vs. Start thread. */
  createThread: [body: string, resolvable: boolean]
}>()

const PAGE_SIZE = 100

/** Comment attachments are stored against the document the MR targets. */
const resolveDocumentId = async () => props.documentId

const { nameOf } = useMembers()
const events = useEventsStore()

// --- activity ----------------------------------------------------------------
/** Older pages already pulled in, oldest-first once merged below. */
const older = ref<ActivityEntry[]>([])
const cursor = ref<string | undefined>(undefined)

const activityQuery = useQuery(
  computed(() =>
    apiQueryOptions('/v1/activity', {
      query: {
        workspaceId: getWorkspaceId(),
        subjectId: props.mergeRequestId,
        limit: String(PAGE_SIZE),
        ...(cursor.value ? { cursor: cursor.value } : {}),
      },
    }),
  ),
)
const activityPage = computed(() => activityQuery.data.value as ListActivityResponse | undefined)
const entries = computed(() => [...(activityPage.value?.entries ?? []), ...older.value])

/** Someone else's approval or merge should land here without a reload. */
watch(
  () => events.revision,
  () => void activityQuery.refetch(),
)

function loadEarlier() {
  const next = activityPage.value?.nextCursor
  if (!next) return
  older.value = entries.value
  cursor.value = next
}

// --- merged rows -------------------------------------------------------------
type Row =
  | { kind: 'note'; id: string; at: number; entry: ActivityEntry }
  | { kind: 'thread'; id: string; at: number; thread: MergeRequestThread }

const rows = computed<Row[]>(() => {
  const notes: Row[] = entries.value
    // Rendered rows only: systemNote() returns null for actions the timeline
    // shows as a thread instead, and filtering here keeps the virtualizer's
    // indices aligned with what is actually on screen.
    .filter((e) => systemNote(e, nameOf, t) !== null)
    .map((entry) => ({
      kind: 'note' as const,
      id: entry.id,
      at: Date.parse(entry.createdAt),
      entry,
    }))
  const threads: Row[] = props.threads.map((thread) => ({
    kind: 'thread' as const,
    id: thread.threadId,
    at: Date.parse(thread.createdAt),
    thread,
  }))
  // Oldest first: a timeline is read forwards, and the composer at the end is
  // then exactly where the next entry will appear.
  return [...notes, ...threads].sort((a, b) => a.at - b.at)
})

function noteAt(index: number) {
  const row = rows.value[index]
  return row?.kind === 'note' ? { ...systemNote(row.entry, nameOf, t)!, entry: row.entry } : null
}
function threadAt(index: number): MergeRequestThread | null {
  const row = rows.value[index]
  return row?.kind === 'thread' ? row.thread : null
}

// --- virtualization against <main> ------------------------------------------
const listEl = ref<HTMLElement | null>(null)
const scrollEl = ref<HTMLElement | null>(null)
/** Distance from the scroller's content top down to this list. */
const scrollMargin = ref(0)
let observer: ResizeObserver | null = null

function measureOffset() {
  const list = listEl.value
  const scroller = scrollEl.value
  if (!list || !scroller) return
  const next =
    list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  // Sub-pixel churn would re-run the virtualizer on every observed frame.
  if (Math.abs(next - scrollMargin.value) > 0.5) scrollMargin.value = next
}

/**
 * Bind to the scroller once the list element exists.
 *
 * Not on mount: the first paint is the loading skeleton, so there is no list
 * to measure from yet and `closest('main')` would find nothing — which is
 * exactly how this rendered an empty feed the first time round. Watching the
 * ref covers the skeleton swapping out, and any later remount.
 */
watch(
  listEl,
  (el) => {
    observer?.disconnect()
    observer = null
    scrollEl.value = el?.closest('main') ?? null
    if (!el || !scrollEl.value) return
    measureOffset()
    // Everything above the feed can change height without the feed knowing —
    // the description being edited, the merge widget switching to its terminal
    // state, the sidebar wrapping under the column on a narrow window.
    const content = scrollEl.value.firstElementChild
    if (content && typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => measureOffset())
      observer.observe(content)
    }
  },
  { flush: 'post' },
)

onMounted(() => window.addEventListener('resize', measureOffset))

onBeforeUnmount(() => {
  observer?.disconnect()
  window.removeEventListener('resize', measureOffset)
})

const virtualizer = useVirtualizer(
  computed(() => {
    // Read through the ref here, not inside getScrollElement — the scroller is
    // only found on mount, and unless the options recompute when it lands the
    // virtualizer stays attached to nothing and renders an empty window.
    const scroller = scrollEl.value
    return {
      count: rows.value.length,
      getScrollElement: () => scroller,
      // Blend of a one-line system note and a collapsed thread card. Rows are
      // measured for real on first paint; this only has to size the scrollbar
      // before that happens.
      estimateSize: () => 64,
      overscan: 8,
      scrollMargin: scrollMargin.value,
      getItemKey: (index: number) => rows.value[index]?.id ?? index,
    }
  }),
)

const items = computed(() => virtualizer.value.getVirtualItems())
const totalSize = computed(() => virtualizer.value.getTotalSize())
/** Rows sit in normal flow inside one wrapper translated to the first row's offset. */
const offsetY = computed(() => (items.value[0]?.start ?? 0) - scrollMargin.value)

function measure(el: Element | { $el?: unknown } | null): void {
  if (el instanceof Element) virtualizer.value.measureElement(el)
}

const loading = computed(() => activityQuery.isPending.value && entries.value.length === 0)
</script>

<template>
  <section class="space-y-3">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-medium">{{ t('mr.activity') }}</h2>
      <Button
        v-if="activityPage?.nextCursor"
        variant="ghost"
        size="xs"
        class="text-muted-foreground"
        :disabled="activityQuery.isFetching.value"
        @click="loadEarlier"
      >
        {{ activityQuery.isFetching.value ? 'Loading…' : 'Load earlier' }}
      </Button>
    </div>

    <div v-if="loading" class="space-y-3" aria-hidden="true">
      <Skeleton v-for="i in 3" :key="i" class="h-7 w-2/3" />
    </div>

    <div v-else>
      <!-- The rail is drawn on the spacer, not on the rows, so it stays
           continuous while rows recycle in and out of the virtual window. It
           wraps only the timeline; the composer below is not an entry on it. -->
      <div class="relative">
        <span
          v-if="rows.length > 0"
          class="absolute top-3 bottom-0 left-[11px] w-px bg-border"
          aria-hidden="true"
        />

      <div ref="listEl" class="relative" :style="{ height: `${totalSize}px` }">
        <div class="absolute top-0 left-0 w-full" :style="{ transform: `translateY(${offsetY}px)` }">
          <div
            v-for="item in items"
            :key="String(item.key)"
            :ref="measure"
            :data-index="item.index"
            class="pb-3"
          >
            <!-- state change -->
            <div v-if="noteAt(item.index)" class="flex items-start gap-2.5">
              <span
                class="mt-px grid size-[23px] shrink-0 place-items-center rounded-full bg-background ring-1 ring-border"
              >
                <component :is="noteAt(item.index)!.icon" class="size-3.5" :class="noteAt(item.index)!.tone" />
              </span>
              <p class="min-w-0 flex-1 text-sm leading-6 text-muted-foreground">
                <span class="font-medium text-foreground">{{ nameOf(noteAt(item.index)!.entry.actor) }}</span>
                {{ ' ' }}{{ noteAt(item.index)!.text }}
                <RouterLink
                  v-if="noteAt(item.index)!.code"
                  :to="`/documents/${documentId}?tab=revisions`"
                  class="ml-1 rounded bg-muted px-1 py-0.5 font-mono text-[11px] text-primary hover:underline"
                >{{ noteAt(item.index)!.code }}</RouterLink>
<span
                  class="text-xs whitespace-nowrap text-muted-foreground/70"
                  :title="fullTime(noteAt(item.index)!.entry.createdAt)"
                >&nbsp;· {{ timelineTime(noteAt(item.index)!.entry.createdAt) }}</span>
              </p>
            </div>

            <!-- discussion -->
            <div v-else-if="threadAt(item.index)" class="flex items-start gap-2.5">
              <span
                class="mt-px grid size-[23px] shrink-0 place-items-center rounded-full bg-background ring-1 ring-border"
              >
                <MessageSquare class="size-3.5 text-muted-foreground" />
              </span>
              <ThreadCard
                class="min-w-0 flex-1"
                :thread="threadAt(item.index)!"
                :outdated="outdatedIds.has(threadAt(item.index)!.threadId)"
                :readonly="readonly"
                :busy="busy"
                :resolve-document-id="resolveDocumentId"
                @reply="(b: string, p: string | null) => emit('reply', threadAt(item.index)!.threadId, b, p)"
                @resolve="(r: boolean) => emit('resolve', threadAt(item.index)!.threadId, r)"
                @edit="(c: string, b: string) => emit('edit', threadAt(item.index)!.threadId, c, b)"
                @delete="(c: string) => emit('delete', threadAt(item.index)!.threadId, c)"
              />
            </div>
          </div>
        </div>
      </div>
      </div>

      <!-- Docked, because a timeline is long and "scroll to the end of the
           history to say something" is not a way to hold a conversation. It
           spans the whole column rather than sitting indented on the rail:
           the rail is a record of what happened, and this is not that yet.
           Outside the virtual window too, so a draft is never unmounted by
           scrolling. -->
      <!-- The margins must sit on the sticky element itself: wrapping it in a
           div its own height leaves it no room to travel, and it never sticks
           at all. `-mb-6` eats the page's own bottom padding and the inner
           `pb-6` puts that space back inside the dock, so the gap under the
           composer is the same whether the dock is pinned or has come to rest
           at the end of the timeline. It spans the content column and stops
           there — bleeding it under the rail would read as a page-wide footer
           bar rather than the foot of this conversation. -->
      <div
        v-if="!readonly"
        class="sticky w-full left-0 bottom-0 z-10 -mb-6 border-t bg-background pt-3 pb-6"
      >
        <CommentComposer
          offer-thread
          :placeholder="t('mr.addComment')"
          :submit-label="t('review.comment')"
          :busy="busy"
          :resolve-document-id="resolveDocumentId"
          @submit="(b: string, r: boolean) => emit('createThread', b, r)"
        />
      </div>

      <p v-else-if="rows.length === 0" class="py-2 text-sm text-muted-foreground">
        {{ t('mr.noActivity') }}
      </p>
    </div>
  </section>
</template>
