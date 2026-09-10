<script setup lang="ts">
/**
 * One inbox row: what happened, to what, how long ago.
 *
 * A button rather than a RouterLink even though it navigates, because clicking
 * it does two things — marks read and goes — and a link that also mutates
 * cannot be opened in a new tab honestly. The href is offered separately by the
 * title, so middle-click still works where it matters.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import type { NotificationEntry } from '@knowledge/contracts'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useMembers } from '@/components/merge-requests/use-members'
import { actorLabel } from '@/components/merge-requests/mr-ui'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import { notificationLink, notificationLook, notificationMessageKey } from './notification-ui'

const props = defineProps<{ entry: NotificationEntry; compact?: boolean }>()
const emit = defineEmits<{ read: [string]; navigated: [] }>()

const { t } = useI18n()
const router = useRouter()
const { nameOf } = useMembers()

const look = computed(() => notificationLook(props.entry))
const href = computed(() => notificationLink(props.entry))
const unread = computed(() => props.entry.readAt === null)
/** Coalesced rows say so, rather than pretending to be a single event. */
const repeats = computed(() => {
  const n = props.entry.metadata.count
  return typeof n === 'number' && n > 1 ? n : null
})
const message = computed(() => {
  const key = notificationMessageKey(props.entry)
  const text = t(key)
  // An event type with no phrase of its own renders as itself rather than as a
  // raw message key, so an event shipped after this catalog is still legible
  // (the `labelFor` rule, applied to a key this module builds).
  return text === key ? props.entry.type : text
})

function open() {
  if (unread.value) emit('read', props.entry.id)
  if (href.value) {
    void router.push(href.value)
    emit('navigated')
  }
}
</script>

<template>
  <button
    type="button"
    class="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    :class="unread ? 'bg-primary/[0.04]' : ''"
    :title="formatDateTime(entry.createdAt)"
    @click="open"
  >
    <component :is="look.icon" class="mt-0.5 size-4 shrink-0" :class="look.class" />

    <span class="min-w-0 flex-1">
      <span class="flex items-baseline gap-1.5">
        <span class="truncate text-sm" :class="unread ? 'font-medium text-foreground' : 'text-muted-foreground'">
          {{ entry.title ?? t('notifications.untitled') }}
        </span>
        <span v-if="repeats" class="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          ×{{ repeats }}
        </span>
      </span>

      <span class="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
        <UserAvatar v-if="entry.actor" :user-id="entry.actor" :name="nameOf(entry.actor)" size="sm" />
        <span class="truncate">
          <template v-if="entry.actor">{{ nameOf(entry.actor) || actorLabel(entry.actor) }} · </template>{{ message }}
        </span>
      </span>

      <span v-if="!compact" class="mt-0.5 block text-[11px] text-muted-foreground/80">
        {{ formatRelative(entry.createdAt) }}
      </span>
    </span>

    <span
      v-if="unread"
      class="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
      :aria-label="t('notifications.unreadMarker')"
    />
  </button>
</template>
