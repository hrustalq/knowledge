<script setup lang="ts">
/**
 * The full inbox (docs/features/22).
 *
 * The bell panel answers "anything new?"; this answers "what have I missed",
 * which is a different reading posture — hence the tab strip, the unread filter
 * and paging, none of which belong in a popover.
 *
 * Tabs are the hand-rolled `?tab=` strip used across settings (there is no
 * shadcn Tabs component here), so a tab is linkable and survives a reload.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { CheckCheck, Settings2 } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import type { NotificationCategory, NotificationEntry } from '@knowledge/contracts'
import { Button } from '@/components/ui/button'
import { useNotificationsStore } from '@/stores/notifications'
import NotificationList from '@/components/notifications/NotificationList.vue'
import { NOTIFICATION_TABS, type NotificationTab } from '@/components/notifications/notification-ui'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useNotificationsStore()

const tab = computed<NotificationTab>(() => {
  const q = route.query.tab
  return NOTIFICATION_TABS.some((x) => x.key === q) ? (q as NotificationTab) : 'all'
})
function setTab(key: NotificationTab) {
  void router.replace({ query: { ...route.query, tab: key } })
}

/**
 * Filtered in the browser, not refetched.
 *
 * The store already holds this page of rows and the tabs are a way of reading
 * them, not a different question — refetching per tab would make switching tabs
 * slower than scrolling. The badges come from the server's own unread tally, so
 * they still count rows beyond what is loaded.
 */
const visible = computed<NotificationEntry[]>(() => {
  if (tab.value === 'all') return store.entries
  if (tab.value === 'unread') return store.entries.filter((e) => e.readAt === null)
  return store.entries.filter((e) => e.category === tab.value)
})

const countFor = (key: NotificationTab): number =>
  key === 'all' || key === 'unread' ? store.unreadCount : store.counts[key as NotificationCategory]

const loadingMore = ref(false)
async function loadMore() {
  loadingMore.value = true
  try {
    await store.loadMore()
  } finally {
    loadingMore.value = false
  }
}

onMounted(() => void store.refresh())
// Arriving on a category with nothing loaded for it yet is the one case where
// the local filter is not enough; one more page usually settles it.
watch(tab, () => {
  if (visible.value.length === 0 && store.nextCursor) void loadMore()
})
</script>

<template>
  <div class="flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-4">
    <header class="flex flex-wrap items-center gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('notifications.title') }}</h1>
        <p class="mt-0.5 text-sm text-muted-foreground">{{ t('notifications.pageSubtitle') }}</p>
      </div>
      <div class="ml-auto flex items-center gap-1.5">
        <Button v-if="store.hasUnread" variant="outline" size="sm" class="gap-1.5" @click="store.markAllRead()">
          <CheckCheck class="size-4" />
          {{ t('notifications.markAllRead') }}
        </Button>
        <Button as-child variant="ghost" size="sm" class="gap-1.5">
          <RouterLink to="/settings/notifications">
            <Settings2 class="size-4" />
            {{ t('notifications.settings') }}
          </RouterLink>
        </Button>
      </div>
    </header>

    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="x in NOTIFICATION_TABS"
        :key="x.key"
        role="tab"
        type="button"
        :aria-selected="tab === x.key"
        class="flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2 text-sm transition-colors"
        :class="
          tab === x.key
            ? 'border-primary font-medium text-primary'
            : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'
        "
        @click="setTab(x.key)"
      >
        {{ t(x.label) }}
        <span
          v-if="countFor(x.key) > 0"
          class="grid h-4 min-w-4 place-items-center rounded-full bg-muted px-1 text-[10px] tabular-nums"
        >{{ countFor(x.key) }}</span>
      </button>
    </div>

    <NotificationList
      :entries="visible"
      :loading="!store.loaded && store.entries.length === 0"
      :has-more="!!store.nextCursor"
      :loading-more="loadingMore"
      :empty-text="tab === 'unread' ? t('notifications.emptyUnread') : t('notifications.empty')"
      @read="store.markRead([$event])"
      @load-more="loadMore"
    />
  </div>
</template>
