<script setup lang="ts">
// Feature 10 (docs/features/10): the workspace / per-document activity stream.
//
// Two shapes, chosen by whether `limit` is given:
//
//   - Unlimited (the Activity page, the document rail): cursor-paginated,
//     auto-loading the next page on scroll and virtualized, so a long-lived
//     workspace feed stays at a few dozen DOM rows.
//   - Capped (`limit`): a single query for N entries, rendered as a plain list
//     with no scroller of its own. Anywhere the feed is a *passage inside
//     something else that scrolls* — a generative UI block in the chat
//     transcript — its own 60vh scrollport is a trap: the wheel stops at its
//     edge, infinite scroll keeps growing a row the transcript is trying to
//     measure, and the reader loses their place in the conversation. A capped
//     feed flows with its parent and ends.
//
// `collapsible` folds either shape down to one line — the newest entry, which
// is the part anyone reads — and is how the feed appears where it is context
// rather than the subject.
import { useI18n } from 'vue-i18n'
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useInfiniteScroll, useVirtualList } from '@vueuse/core'
import { ChevronRight } from 'lucide-vue-next'
import type { ActivityEntry, ListActivityResponse } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId, relativeTime } from '@/lib/api'
import { useEventsStore } from '@/stores/events'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import UserChip from '@/components/people/UserChip.vue'
import { useMembers } from '@/components/merge-requests/use-members'
import { isRealAccount } from '@/components/merge-requests/mr-ui'

const { t } = useI18n()
const { nameOf } = useMembers()

const props = withDefaults(
  defineProps<{
    documentId?: string
    /** One project's feed (docs/features/24): everything that touched its pages. */
    projectId?: string
    pageSize?: number
    height?: string
    /** Cap the feed at N entries in one query: no paging, no scroller of its own. */
    limit?: number
    /** Start folded to the newest entry, expandable. */
    collapsible?: boolean
  }>(),
  { pageSize: 50, height: '60vh' },
)

/** Row height must match the markup below — the virtualizer positions by it. */
const ROW_HEIGHT = 34

const entries = ref<ActivityEntry[]>([])
const loaded = ref(false)
const busy = ref(false)
const nextCursor = ref<string | null>(null)
const events = useEventsStore()

const capped = computed(() => props.limit !== undefined)
const open = ref(!props.collapsible)

const { list, containerProps, wrapperProps } = useVirtualList(entries, {
  itemHeight: ROW_HEIGHT,
  overscan: 10,
})

/** One row shape for both modes, so the markup below is written once. */
const visible = computed(() =>
  capped.value ? entries.value.map((data, index) => ({ data, index })) : list.value,
)

const newest = computed<ActivityEntry | null>(() => entries.value[0] ?? null)

/**
 * The action code IS the key path (activity.action.<code>, stored nested since
 * vue-i18n reads a dot as a separator), so there is no second map to keep in
 * sync. An unknown code falls back to itself rather than rendering a raw key.
 */

function label(e: ActivityEntry): string {
  const key = `activity.action.${e.action}`
  const text = t(key)
  return text === key ? e.action : text
}

/**
 * The actor's name.
 *
 * This used to be `e.actor.slice(0, 8)` — eight characters of a UUID, printed
 * where a person's name belongs. `nameOf` resolves it against the member roster
 * the app already has cached, and still falls back to `actorLabel` for actors
 * who are not members: the dev stub, and agents, which write activity under
 * their own key rather than a user id.
 */
function actor(e: ActivityEntry): string {
  return nameOf(e.actor)
}

/**
 * Only a real account gets a chip. The dev principal has no `users` row and an
 * agent writes under a slug key — neither has a profile to open.
 */
function isPerson(e: ActivityEntry): boolean {
  return isRealAccount(e.actor)
}

function title(e: ActivityEntry): string {
  return e.documentTitle ?? (e.metadata.title as string) ?? e.documentId?.slice(0, 8) ?? ''
}

/** The folded line: the same sentence a row makes, without the link. */
function summary(e: ActivityEntry): string {
  return [actor(e), label(e), title(e)].filter(Boolean).join(' ')
}

async function fetchPage(cursor?: string): Promise<ListActivityResponse> {
  const params = new URLSearchParams({
    workspaceId: getWorkspaceId(),
    limit: String(props.limit ?? props.pageSize),
  })
  if (props.documentId) params.set('documentId', props.documentId)
  if (props.projectId) params.set('projectId', props.projectId)
  if (cursor) params.set('cursor', cursor)
  return apiFetch<ListActivityResponse>(`/v1/activity?${params}`)
}

/** First page — resets the list (initial mount / workspace or document change). */
async function reload() {
  busy.value = true
  try {
    const res = await fetchPage()
    entries.value = res.entries
    nextCursor.value = res.nextCursor
    loaded.value = true
  } finally {
    busy.value = false
  }
}

/** Next page — appended, driven by the scroll handler and the fallback button. */
async function loadMore() {
  if (busy.value || !nextCursor.value || capped.value) return
  busy.value = true
  try {
    const res = await fetchPage(nextCursor.value)
    entries.value = [...entries.value, ...res.entries]
    nextCursor.value = res.nextCursor
  } finally {
    busy.value = false
  }
}

/**
 * Live refresh (feature 04): re-pull only the first page and splice in what we
 * haven't seen, so an incoming event doesn't discard the pages already loaded.
 * A capped feed stays capped — it trims back to `limit` rather than growing.
 */
/**
 * Live refresh is driven by an event counter that ticks for the whole
 * workspace, and a dependent re-index ticks it once per page it touched. One
 * request per tick meant a burst of them asking the same question; the answer
 * to the second is whatever the first is already fetching.
 */
let headInFlight = false

async function refreshHead() {
  if (!loaded.value || headInFlight) return
  headInFlight = true
  try {
    await pullHead()
  } finally {
    headInFlight = false
  }
}

async function pullHead() {
  const res = await fetchPage()
  const known = new Set(entries.value.map((e) => e.id))
  const fresh = res.entries.filter((e) => !known.has(e.id))
  if (fresh.length === 0) return
  const merged = [...fresh, ...entries.value]
  entries.value = props.limit === undefined ? merged : merged.slice(0, props.limit)
}

useInfiniteScroll(containerProps.ref, () => loadMore(), {
  distance: ROW_HEIGHT * 6,
  canLoadMore: () => !capped.value && nextCursor.value !== null && !busy.value,
})

onMounted(() => void reload())
watch([() => props.documentId, () => props.projectId], () => void reload())
watch(() => events.revision, () => void refreshHead())
</script>

<template>
  <div class="flex min-h-0 flex-col gap-2">
    <!-- Folded, this is the whole component: what happened last, and when. -->
    <button
      v-if="collapsible"
      type="button"
      class="flex w-full items-baseline gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      :aria-expanded="open"
      @click="open = !open"
    >
      <ChevronRight
        class="size-3.5 shrink-0 self-center text-muted-foreground transition-transform duration-200"
        :class="open ? 'rotate-90' : ''"
      />
      <span v-if="!loaded" class="text-muted-foreground">{{ t('activity.loading') }}</span>
      <span v-else-if="!newest" class="text-muted-foreground">{{ t('activity.empty') }}</span>
      <template v-else-if="open">
        <span class="text-muted-foreground">{{ t('count.events', { n: entries.length }, entries.length) }}</span>
      </template>
      <span v-else class="truncate text-muted-foreground">{{ summary(newest) }}</span>
      <span v-if="newest && !open" class="ml-auto shrink-0 text-xs text-muted-foreground">
        {{ relativeTime(newest.createdAt) }}
      </span>
    </button>

    <template v-if="open">
      <div v-if="!loaded" class="space-y-2">
        <Skeleton v-for="i in 3" :key="i" class="h-8 w-full" />
      </div>
      <p v-else-if="entries.length === 0" class="text-sm text-muted-foreground">{{ t('activity.empty') }}</p>
      <template v-else>
        <!-- Capped mode drops the virtualizer's container/wrapper bindings, and
             with them the nested scrollport: the rows just flow. -->
        <div
          v-bind="capped ? {} : containerProps"
          :style="capped ? undefined : { height: props.height }"
          class="rounded-md"
        >
          <div v-bind="capped ? {} : wrapperProps">
            <div
              v-for="{ data: e, index } in visible"
              :key="e.id ?? index"
              class="flex items-baseline gap-2 rounded-md px-2 text-sm hover:bg-muted/50"
              :style="{ height: `${ROW_HEIGHT}px` }"
            >
              <UserChip
                v-if="isPerson(e)"
                :user-id="e.actor"
                size="sm"
                class="max-w-[9rem] shrink-0 font-medium"
              />
              <span v-else class="shrink-0 font-medium">{{ actor(e) }}</span>
              <span class="shrink-0 text-muted-foreground">{{ label(e) }}</span>
              <RouterLink
                v-if="e.documentId"
                :to="`/documents/${e.documentId}`"
                class="truncate font-medium hover:underline"
              >
                {{ title(e) }}
              </RouterLink>
              <span class="ml-auto shrink-0 text-xs text-muted-foreground">{{ relativeTime(e.createdAt) }}</span>
            </div>
          </div>
        </div>

        <!-- Capped: the feed ends here, so the way on is the full page. Otherwise
             scrolling pages in automatically and the button is the keyboard path. -->
        <div class="flex items-center gap-3 px-2 text-xs text-muted-foreground">
          <template v-if="capped">
            <span>{{ t('activity.mostRecent', { n: entries.length }) }}</span>
            <RouterLink to="/activity" class="underline underline-offset-2 hover:text-foreground">
              {{ t('activity.viewAll') }}
            </RouterLink>
          </template>
          <template v-else>
            <span>{{ entries.length }} loaded{{ nextCursor ? '' : ' — end of feed' }}</span>
            <Button v-if="nextCursor" variant="outline" size="sm" :disabled="busy" @click="loadMore">
              {{ busy ? 'Loading…' : 'Load more' }}
            </Button>
          </template>
        </div>
      </template>
    </template>
  </div>
</template>
