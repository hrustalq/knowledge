<script setup lang="ts">
/**
 * What the caller wants to hear about, in this workspace (docs/features/22).
 *
 * Per workspace rather than per account, because the answer genuinely differs:
 * somebody may follow every page in the team space they own and want nothing
 * but mentions from the one they were added to last week.
 *
 * Every row saves on its own, like ProfileSettingsPage — a single Save covering
 * both a category toggle and an unrelated switch would make the toggle look
 * unapplied until you pressed something else.
 *
 * Two groups, matching that page's shape so the two settings surfaces read as
 * one system: what reaches you, and what you follow. The auto-watch rule sits
 * with the second, not the first — "commenting starts watching" is a rule about
 * following, and grouping it with the categories left it stranded under a
 * column while the other one stood empty.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { RouterLink } from 'vue-router'
import { useVirtualList } from '@vueuse/core'
import { Bell, Eye } from 'lucide-vue-next'
import type {
  ListNotificationSubscriptionsResponse,
  NotificationCategory,
  NotificationPreferences,
  NotificationSubscriptionEntry,
} from '@knowledge/contracts'
import { NOTIFICATION_CATEGORIES } from '@knowledge/contracts'
import { apiFetch, getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { categoryLook } from '@/components/notifications/notification-ui'

const { t } = useI18n()

const prefs = ref<NotificationPreferences | null>(null)
const subscriptions = ref<NotificationSubscriptionEntry[]>([])
const loading = ref(true)
const saving = ref(false)

const muted = computed(() => new Set(prefs.value?.mutedCategories ?? []))

/* ------------------------------------------------- the followed-subject list */
/*
 * Paged, virtualized, and bounded to a card — see `.kn-watchlist`.
 *
 * Watching is cumulative and nothing prunes it: commenting on a page starts
 * watching it, so this list is a record of everywhere somebody has ever spoken
 * up. It was drawn in full, every row, under a card that grew to fit — which
 * made a long-lived account's preferences page thousands of rows of DOM and put
 * the switches above it out of reach. Now the card is a fixed scrollport, the
 * virtualizer keeps the DOM to the dozen rows on screen, and the next page
 * arrives as you approach the end.
 */

/** Must match the row markup below — the virtualizer positions by it. */
const WATCH_ROW_HEIGHT = 60
const WATCH_PAGE = 50

const nextCursor = ref<string | null>(null)
const loadingMore = ref(false)

const { list: watchRows, containerProps, wrapperProps } = useVirtualList(subscriptions, {
  itemHeight: WATCH_ROW_HEIGHT,
  overscan: 8,
})

function subscriptionsUrl(cursor?: string): string {
  const params = new URLSearchParams({
    workspaceId: getWorkspaceId(),
    limit: String(WATCH_PAGE),
  })
  if (cursor) params.set('cursor', cursor)
  return `/v1/notifications/subscriptions?${params}`
}

async function loadMoreSubscriptions() {
  if (loadingMore.value || !nextCursor.value) return
  loadingMore.value = true
  try {
    const res = await apiFetch<ListNotificationSubscriptionsResponse>(
      subscriptionsUrl(nextCursor.value),
    )
    subscriptions.value = [...subscriptions.value, ...res.subscriptions]
    nextCursor.value = res.nextCursor
  } catch {
    toast.error(t('notifications.settingsLoadFailed'))
  } finally {
    loadingMore.value = false
  }
}

/**
 * Page in from the virtualizer's own window rather than from a scroll
 * measurement.
 *
 * `useInfiniteScroll` compares `scrollHeight` against `clientHeight`, and on
 * mount the virtual list's spacer has not been sized yet — so the container
 * measures as "already at the bottom", fires, measures stale again, and walks
 * the entire cursor in one burst. It paged 478 rows into a card that shows
 * seven. The index of the last row the virtualizer has decided to render is the
 * same question asked of data instead of layout, so it cannot race the DOM.
 */
watch(watchRows, (rows) => {
  const last = rows.length ? rows[rows.length - 1].index : -1
  if (last >= subscriptions.value.length - 8) void loadMoreSubscriptions()
})

async function load() {
  loading.value = true
  try {
    const ws = getWorkspaceId()
    const [p, s] = await Promise.all([
      apiFetch<NotificationPreferences>(`/v1/notifications/preferences?workspaceId=${ws}`),
      apiFetch<ListNotificationSubscriptionsResponse>(subscriptionsUrl()),
    ])
    prefs.value = p
    subscriptions.value = s.subscriptions
    nextCursor.value = s.nextCursor
  } catch {
    toast.error(t('notifications.settingsLoadFailed'))
  } finally {
    loading.value = false
  }
}

async function save(patch: Partial<Pick<NotificationPreferences, 'mutedCategories' | 'autoWatchOnComment'>>) {
  if (!prefs.value) return
  saving.value = true
  const previous = { ...prefs.value }
  // Applied first: a switch that waits for a round trip before moving reads as
  // a switch that did not register the press.
  prefs.value = { ...prefs.value, ...patch }
  try {
    prefs.value = await apiFetch<NotificationPreferences>('/v1/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify({ workspaceId: getWorkspaceId(), ...patch }),
    })
  } catch {
    prefs.value = previous
    toast.error(t('notifications.settingsSaveFailed'))
  } finally {
    saving.value = false
  }
}

function toggleCategory(category: NotificationCategory) {
  const next = new Set(muted.value)
  if (next.has(category)) next.delete(category)
  else next.add(category)
  void save({ mutedCategories: [...next] })
}

async function unwatch(entry: NotificationSubscriptionEntry) {
  try {
    await apiFetch('/v1/notifications/subscriptions', {
      method: 'PUT',
      body: JSON.stringify({
        workspaceId: getWorkspaceId(),
        subjectType: entry.subjectType,
        subjectId: entry.subjectId,
        state: 'default',
      }),
    })
    subscriptions.value = subscriptions.value.filter((s) => s.id !== entry.id)
  } catch {
    toast.error(t('notifications.settingsSaveFailed'))
  }
}

function linkFor(entry: NotificationSubscriptionEntry): string {
  if (entry.subjectType === 'merge-request') return `/merge-requests/${entry.subjectId}`
  if (entry.subjectType === 'project') return `/settings/projects/${entry.subjectId}`
  return `/documents/${entry.subjectId}`
}

onMounted(load)
</script>

<template>
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('notifications.title') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('notifications.settingsSubtitle') }}</p>
    </div>

    <div v-if="loading" class="grid items-start gap-5 lg:grid-cols-2">
      <Skeleton v-for="i in 2" :key="i" class="h-64 w-full" />
    </div>

    <div v-else class="grid min-w-0 items-start gap-5 lg:grid-cols-2">
      <!-- What arrives -->
      <section class="min-w-0 rounded-xl border bg-card">
        <div class="border-b px-5 py-3.5">
          <h2 class="font-display text-[15px] font-semibold tracking-tight">
            {{ t('notifications.categoriesTitle') }}
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('notifications.categoriesHint') }}</p>
        </div>

        <ul class="divide-y">
          <li
            v-for="category in NOTIFICATION_CATEGORIES"
            :key="category"
            class="flex items-center gap-3 px-5 py-3"
          >
            <component
              :is="categoryLook(category).icon"
              class="size-4 shrink-0"
              :class="categoryLook(category).class"
            />
            <span class="min-w-0 flex-1">
              <span class="block text-sm font-medium">{{ t(`notifications.category.${category}`) }}</span>
              <span class="block text-xs text-muted-foreground">
                {{ t(`notifications.categoryHint.${category}`) }}
              </span>
            </span>
            <Button
              :variant="muted.has(category) ? 'outline' : 'default'"
              size="sm"
              class="shrink-0"
              :disabled="saving"
              :aria-pressed="!muted.has(category)"
              @click="toggleCategory(category)"
            >
              {{ muted.has(category) ? t('notifications.off') : t('notifications.on') }}
            </Button>
          </li>
        </ul>
      </section>

      <!-- What the caller follows: the rule that adds things, then the things -->
      <section class="min-w-0 rounded-xl border bg-card">
        <div class="border-b px-5 py-3.5">
          <h2 class="font-display text-[15px] font-semibold tracking-tight">
            {{ t('notifications.watchingTitle') }}
          </h2>
          <p class="mt-0.5 text-xs text-muted-foreground">{{ t('notifications.watchingHint') }}</p>
        </div>

        <!-- The rule that adds things sits above the scrollport, not inside it:
             it is a preference, not a subject, and scrolling it away with the
             list is what made it hard to find. -->
        <div class="flex items-center gap-3 border-b px-5 py-3">
          <span class="min-w-0 flex-1">
            <span class="block text-sm font-medium">{{ t('notifications.autoWatchTitle') }}</span>
            <span class="block text-xs text-muted-foreground">{{ t('notifications.autoWatchHint') }}</span>
          </span>
          <Button
            :variant="prefs?.autoWatchOnComment ? 'default' : 'outline'"
            size="sm"
            class="shrink-0"
            :disabled="saving"
            :aria-pressed="!!prefs?.autoWatchOnComment"
            @click="save({ autoWatchOnComment: !prefs?.autoWatchOnComment })"
          >
            {{ prefs?.autoWatchOnComment ? t('notifications.on') : t('notifications.off') }}
          </Button>
        </div>

        <p v-if="subscriptions.length === 0" class="px-5 py-4 text-sm text-muted-foreground">
          {{ t('notifications.watchingEmpty') }}
        </p>

        <template v-else>
          <!-- Server order (newest first) rather than watching-then-muted: the
               two states are a label on the row, and re-grouping client-side
               can only sort the pages already fetched — which would reshuffle
               the list under the reader as the next one arrives. -->
          <div v-bind="containerProps" class="kn-watchlist quiet-scroll">
            <div v-bind="wrapperProps">
              <div
                v-for="{ data: entry, index } in watchRows"
                :key="entry.id ?? index"
                class="flex items-center gap-3 border-b px-5"
                :style="{ height: `${WATCH_ROW_HEIGHT}px` }"
              >
                <component
                  :is="entry.state === 'muted' ? Bell : Eye"
                  class="size-4 shrink-0 text-muted-foreground"
                />
                <span class="min-w-0 flex-1">
                  <!-- The thing's name, not its id. The kind moves to the
                       second line beside the state, where it qualifies rather
                       than competes: a reader scanning this list is looking for
                       a page they remember by title. An id appears only when
                       the subject is gone and there is no title left to show. -->
                  <RouterLink
                    :to="linkFor(entry)"
                    class="block truncate text-sm text-primary underline-offset-2 hover:underline"
                    :title="entry.title ?? entry.subjectId"
                  >
                    {{ entry.title ?? entry.subjectId.slice(0, 8) }}
                  </RouterLink>
                  <span class="block truncate text-xs text-muted-foreground">
                    {{ t(`notifications.subject.${entry.subjectType}`) }} ·
                    {{ entry.state === 'muted' ? t('notifications.watch.muted') : t('notifications.watch.watching') }}
                  </span>
                </span>
                <Button variant="ghost" size="sm" class="shrink-0" @click="unwatch(entry)">
                  {{ t('notifications.forget') }}
                </Button>
              </div>
            </div>
          </div>

          <!-- Scrolling pages the list in; the button is the keyboard path to
               the same thing, as on the activity feed. -->
          <div class="flex items-center gap-3 px-5 py-2.5 text-xs text-muted-foreground">
            <span class="tabular-nums">
              {{ t('notifications.watchingLoaded', { n: subscriptions.length }) }}
            </span>
            <Button
              v-if="nextCursor"
              variant="outline"
              size="sm"
              :disabled="loadingMore"
              @click="loadMoreSubscriptions"
            >
              {{ loadingMore ? t('common.loading') : t('common.loadMore') }}
            </Button>
          </div>
        </template>
      </section>
    </div>
  </div>
</template>
