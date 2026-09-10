<script setup lang="ts">
/**
 * A person, wherever one is named (docs/features/23).
 *
 * Before this, every surface spelled out its own `<UserAvatar>` plus
 * `{{ nameOf(id) }}` pair — around twenty-five of them — and the ones that had
 * not been got to yet rendered eight characters of a UUID at the reader. One
 * component means a face, a name and a way to find out who that is arrive
 * together everywhere, including the places nobody remembered to wire up.
 *
 * ## Hover is not available everywhere
 *
 * A hover card on a touch device is a card nobody can open. So the trigger
 * carries both: a HoverCard under `(hover: hover)`, and a tap-driven Popover
 * otherwise — the same two-surface split `ui/popover/ResponsivePopover.vue`
 * makes, for the same reason. `useMediaQuery` reads false during SSR, which is
 * the popover branch; both are closed at hydration and the trigger markup is
 * identical either way, so there is nothing to mismatch.
 *
 * The card is mounted only while open, and `UserCard` only fetches then.
 */
import { computed, ref } from 'vue'
import { useMediaQuery } from '@vueuse/core'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import UserAvatar from '@/components/merge-requests/UserAvatar.vue'
import { useMembers } from '@/components/merge-requests/use-members'
import { actorLabel } from '@/components/merge-requests/mr-ui'
import UserCard from './UserCard.vue'

const props = withDefaults(
  defineProps<{
    userId: string
    /** Overrides the roster lookup — for actors who are not workspace members. */
    name?: string
    size?: 'sm' | 'md'
    /** Face only. For dense rows (a stacked reviewer list) where a name would not fit. */
    avatarOnly?: boolean
    /** An agent wrote this, so the face is a glyph and there is no profile behind it. */
    ai?: boolean
    /** Agent display name, used instead of a person's when `ai`. */
    agentName?: string
  }>(),
  { name: undefined, size: 'md', avatarOnly: false, ai: false, agentName: undefined },
)

const { memberOf } = useMembers()
const member = computed(() => memberOf(props.userId))
const label = computed(
  () => props.agentName ?? props.name ?? member.value?.displayName ?? actorLabel(props.userId),
)
const avatar = computed(() => member.value?.avatarUrl ?? null)

const open = ref(false)
const canHover = useMediaQuery('(hover: hover)')
</script>

<template>
  <!-- An agent has no profile to open, so it is a plain mark: offering a card
       that resolves to nobody is worse than not offering one. -->
  <span v-if="ai" class="inline-flex min-w-0 items-center gap-1.5">
    <UserAvatar :user-id="userId" :name="label" :size="size" ai />
    <span v-if="!avatarOnly" class="truncate">{{ label }}</span>
  </span>

  <HoverCard v-else-if="canHover" v-model:open="open" :open-delay="220" :close-delay="120">
    <HoverCardTrigger as-child>
      <RouterLink
        :to="`/u/${userId}`"
        class="inline-flex min-w-0 items-center gap-1.5 rounded-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :title="label"
      >
        <UserAvatar :user-id="userId" :name="label" :src="avatar" :size="size" />
        <span v-if="!avatarOnly" class="truncate">{{ label }}</span>
      </RouterLink>
    </HoverCardTrigger>
    <HoverCardContent class="w-72" :side-offset="8">
      <UserCard :user-id="userId" :open="open" />
    </HoverCardContent>
  </HoverCard>

  <Popover v-else v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        :title="label"
      >
        <UserAvatar :user-id="userId" :name="label" :src="avatar" :size="size" />
        <span v-if="!avatarOnly" class="truncate">{{ label }}</span>
      </button>
    </PopoverTrigger>
    <PopoverContent class="w-72" :side-offset="8">
      <UserCard :user-id="userId" :open="open" />
    </PopoverContent>
  </Popover>
</template>
