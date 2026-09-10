<script setup lang="ts">
/**
 * Watch, mute or forget one subject (docs/features/22).
 *
 * Three states rather than a toggle, because "not watching" and "muted" are
 * different answers: the first lets involvement subscribe you later — commenting
 * on a page starts watching it — and the second is a standing instruction that
 * survives it. A two-state toggle would silently re-subscribe somebody the next
 * time they replied to a thread they had deliberately left.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { Bell, BellOff, BellRing, Check } from 'lucide-vue-next'
import type {
  ListNotificationSubscriptionsResponse,
  NotificationSubjectType,
  SubscriptionState,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const props = withDefaults(
  defineProps<{
    subjectType: NotificationSubjectType
    subjectId: string
    /** Icon-only, for a crowded header. */
    compact?: boolean
  }>(),
  { compact: false },
)

const { t } = useI18n()
const queryClient = useQueryClient()

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/notifications/subscriptions', {
      query: {
        workspaceId: getWorkspaceId(),
        subjectType: props.subjectType,
        subjectId: props.subjectId,
      },
    }),
  ),
)

const state = computed<SubscriptionState>(() => {
  const rows = (query.data.value as ListNotificationSubscriptionsResponse | undefined)?.subscriptions
  const mine = rows?.find((r) => r.subjectId === props.subjectId)
  return mine ? mine.state : 'default'
})

const look = computed(() => {
  if (state.value === 'watching') return { icon: BellRing, label: t('notifications.watch.watching') }
  if (state.value === 'muted') return { icon: BellOff, label: t('notifications.watch.muted') }
  return { icon: Bell, label: t('notifications.watch.notWatching') }
})

const setState = useApiMutation('put', '/v1/notifications/subscriptions', {
  invalidates: () => [['/v1/notifications/subscriptions']],
})

const OPTIONS: { state: SubscriptionState; label: string; hint: string }[] = [
  { state: 'watching', label: 'notifications.watch.watching', hint: 'notifications.watch.watchingHint' },
  { state: 'default', label: 'notifications.watch.notWatching', hint: 'notifications.watch.notWatchingHint' },
  { state: 'muted', label: 'notifications.watch.muted', hint: 'notifications.watch.mutedHint' },
]

function choose(next: SubscriptionState) {
  setState.mutate(
    {
      body: {
        workspaceId: getWorkspaceId(),
        subjectType: props.subjectType,
        subjectId: props.subjectId,
        state: next,
      },
    },
    { onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['/v1/notifications/subscriptions'] }) },
  )
}
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <Button
        :variant="state === 'watching' ? 'secondary' : 'ghost'"
        :size="compact ? 'icon-sm' : 'sm'"
        :disabled="setState.isPending.value"
        :title="look.label"
        :aria-label="look.label"
        class="gap-1.5"
      >
        <component :is="look.icon" class="size-4" />
        <span v-if="!compact" class="text-xs">{{ look.label }}</span>
      </Button>
    </DropdownMenuTrigger>

    <DropdownMenuContent align="end" class="min-w-60">
      <DropdownMenuItem
        v-for="option in OPTIONS"
        :key="option.state"
        class="items-start gap-2"
        @select="choose(option.state)"
      >
        <Check class="mt-0.5 size-3.5 shrink-0" :class="state === option.state ? '' : 'invisible'" />
        <span class="flex flex-col gap-0.5">
          <span class="text-sm">{{ t(option.label) }}</span>
          <span class="text-xs text-muted-foreground">{{ t(option.hint) }}</span>
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
