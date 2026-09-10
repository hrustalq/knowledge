<script setup lang="ts">
/**
 * One person, summarized (docs/features/23).
 *
 * Two layers, deliberately. The roster the app already has cached answers name,
 * email and role for free, so the card is never empty on open; the profile
 * query fills in membership and workload, and only runs when a card is actually
 * opened — it is five queries server-side, and firing it per row of a member
 * list would be a stampede for something nobody asked to see.
 *
 * `enabled` is what enforces that: the query is inert until the host says the
 * card is open.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { FileText, GitPullRequest, MessageSquare } from 'lucide-vue-next'
import type { UserProfileResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import { useMembers } from '@/components/merge-requests/use-members'
import { actorLabel } from '@/components/merge-requests/mr-ui'

const props = defineProps<{ userId: string; open: boolean }>()

const { t } = useI18n()
const { memberOf } = useMembers()
const member = computed(() => memberOf(props.userId))

const profileQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/profiles/{userId}', {
      path: { userId: props.userId },
      query: { workspaceId: getWorkspaceId() },
    }),
    enabled: props.open,
    // A person's page count does not move minute to minute, and the same card
    // is opened repeatedly while scanning a discussion.
    staleTime: 60_000,
  })),
)
const profile = computed(() => profileQuery.data.value as UserProfileResponse | undefined)

const name = computed(() => profile.value?.displayName ?? member.value?.displayName ?? actorLabel(props.userId))
const email = computed(() => profile.value?.email ?? member.value?.email ?? '')
const avatar = computed(() => profile.value?.avatarUrl ?? member.value?.avatarUrl ?? null)
const role = computed(() => profile.value?.role ?? member.value?.role ?? null)
const disabled = computed(() => profile.value?.disabled ?? member.value?.disabled ?? false)

/** Only the counts worth a line. A zero is not news, so it is not shown. */
const stats = computed(() => {
  const p = profile.value
  if (!p) return []
  return [
    { icon: FileText, value: p.pageCount, label: t('people.pages', p.pageCount) },
    {
      icon: GitPullRequest,
      value: p.openWork.authoredMergeRequests,
      label: t('people.openMrs', p.openWork.authoredMergeRequests),
    },
    {
      icon: MessageSquare,
      value: p.openWork.unresolvedThreads,
      label: t('people.unresolved', p.openWork.unresolvedThreads),
    },
  ].filter((s) => s.value > 0)
})
</script>

<template>
  <div class="space-y-3">
    <div class="flex items-start gap-3">
      <UserAvatar
        :user-id="userId"
        :name="name"
        :src="avatar"
        class="!size-10 !text-sm"
      />
      <div class="min-w-0 flex-1">
        <RouterLink
          :to="`/u/${userId}`"
          class="block truncate font-medium hover:underline"
          :title="name"
        >
          {{ name }}
        </RouterLink>
        <p v-if="email" class="truncate text-xs text-muted-foreground" :title="email">
          {{ email }}
        </p>
      </div>
    </div>

    <div v-if="role || disabled" class="flex flex-wrap items-center gap-1.5">
      <Badge v-if="role" variant="secondary" class="text-[10px]">{{ t(`role.${role}`) }}</Badge>
      <Badge v-if="profile?.isAdmin" variant="secondary" class="text-[10px]">
        {{ t('people.platformAdmin') }}
      </Badge>
      <Badge v-if="disabled" variant="outline" class="text-[10px] text-destructive">
        {{ t('people.disabled') }}
      </Badge>
    </div>

    <!-- Reserved while loading rather than collapsed, so the card does not
         jump under a pointer that is still resting on the trigger. -->
    <div v-if="profileQuery.isPending.value && open" class="h-8 animate-pulse rounded bg-muted/60" />
    <ul v-else-if="stats.length" class="space-y-1 text-xs text-muted-foreground">
      <li v-for="s in stats" :key="s.label" class="flex items-center gap-1.5">
        <component :is="s.icon" class="size-3.5 shrink-0" aria-hidden="true" />
        <span>{{ s.label }}</span>
      </li>
    </ul>

    <p v-if="profile?.memberSince" class="text-xs text-muted-foreground">
      {{ t('people.memberSince', { when: relativeTime(profile.memberSince) }) }}
    </p>
  </div>
</template>
