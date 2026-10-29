<script setup lang="ts">
/**
 * The topbar bell (docs/features/22).
 *
 * `ResponsivePopover` rather than a DropdownMenu: the panel holds a scrolling
 * list and its own actions, and on a phone a dropdown that tall is unusable —
 * this becomes a bottom sheet there for free.
 *
 * The badge is the store's count, not the loaded rows' — the panel holds twenty
 * and somebody can have more, so counting what is on screen would quietly cap
 * the number at twenty.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Bell, CheckCheck, Settings2 } from 'lucide-vue-next'
import { RouterLink } from 'vue-router'
import { Button } from '@/shared/ui/button'
import { ResponsivePopover } from '@/shared/ui/popover'
import { useNotificationsStore } from '@/modules/notifications/model/notifications.store'
import { useAuthStore } from '@/stores/auth'
import { useEventsStore } from '@/stores/events'
import NotificationList from './NotificationList.vue'

const { t } = useI18n()
const store = useNotificationsStore()
const auth = useAuthStore()
const open = ref(false)

/** Cap the panel; the page is where a long history is read. */
const PANEL_ROWS = 8
const shown = computed(() => store.entries.slice(0, PANEL_ROWS))
const badge = computed(() => (store.unreadCount > 99 ? '99+' : String(store.unreadCount)))

onMounted(() => {
  if (auth.authenticated) void store.refreshCount()
})

// Opening is the moment to fetch rows — the badge alone needs no list, so the
// panel's contents are not paid for until somebody asks to see them.
watch(open, (isOpen) => {
  if (isOpen) void store.refresh()
})

// The bell is mounted wherever the event stream is connected (the app shell),
// so it is where `notification.created` lands. The badge is the only thing that
// always needs updating; the panel and the page refetch through the live-cache
// rule when they are open. Toasted only for a mention: everything else is news
// you will read when you look, while being named is somebody waiting on you.
const events = useEventsStore()
watch(
  () => events.lastEvent,
  (event) => {
    if (event?.type !== 'notification.created') return
    void store.refreshCount()
    if (event.reason === 'mention') {
      toast.info(t('notifications.toastMention', { name: event.title ?? t('notifications.untitled') }))
    }
  },
)
</script>

<template>
  <ResponsivePopover
    v-model:open="open"
    :title="t('notifications.title')"
    align="end"
    side="bottom"
    panel-class="w-[22rem] p-2"
  >
    <!-- Named by its content, so the visible count is part of the name
         (WCAG 2.5.3) — an aria-label would drop it. -->
    <template #trigger>
      <Button variant="ghost" size="icon-sm" class="relative">
        <Bell class="size-4" />
        <span class="sr-only">{{ t('notifications.title') }}</span>
        <span
          v-if="store.hasUnread"
          class="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-micro font-medium tabular-nums text-primary-foreground"
        >{{ badge }}</span>
      </Button>
    </template>

    <div class="flex items-center gap-1 px-1 pb-1.5">
      <span class="text-sm font-medium">{{ t('notifications.title') }}</span>
      <span v-if="store.hasUnread" class="text-xs text-muted-foreground">
        {{ t('notifications.unreadCount', { n: store.unreadCount }) }}
      </span>
      <Button
        v-if="store.hasUnread"
        variant="ghost"
        size="icon-sm"
        class="ml-auto"
        :title="t('notifications.markAllRead')"
        :aria-label="t('notifications.markAllRead')"
        @click="store.markAllRead()"
      >
        <CheckCheck class="size-4" />
      </Button>
      <Button
        as-child
        variant="ghost"
        size="icon-sm"
        :class="store.hasUnread ? '' : 'ml-auto'"
        :title="t('notifications.settings')"
      >
        <RouterLink to="/settings/notifications" @click="open = false">
          <Settings2 class="size-4" />
        </RouterLink>
      </Button>
    </div>

    <div class="max-h-[24rem] overflow-y-auto">
      <NotificationList
        :entries="shown"
        :loading="!store.loaded && store.entries.length === 0"
        :error="store.error"
        compact
        @retry="store.refresh()"
        @read="store.markRead([$event])"
        @navigated="open = false"
      />
    </div>

    <div class="border-t pt-1.5">
      <Button as-child variant="ghost" size="sm" class="w-full justify-center text-xs">
        <RouterLink to="/notifications" @click="open = false">{{ t('notifications.seeAll') }}</RouterLink>
      </Button>
    </div>
  </ResponsivePopover>
</template>
