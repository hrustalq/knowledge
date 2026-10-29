<script setup lang="ts">
/**
 * The page's owner (docs/features/39): one member, or nobody.
 *
 * A reader sees a chip; an editor gets a popover roster — the same list the
 * merge-request assignee uses, filtered as you type, with "Unowned" pinned at
 * the top because the dashboard's whole point is that unowned is a real state
 * and not an error. The trigger is a plain button around an avatar and a name
 * rather than a `UserChip`: the chip is itself a hover-card trigger, and a
 * button inside a button is invalid markup.
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, UserRound } from 'lucide-vue-next'
import { Popover, PopoverContent, PopoverTrigger } from '@/shared/ui/popover'
import { Input } from '@/shared/ui/input'
import UserAvatar from '@/widgets/person/UserAvatar.vue'
import UserChip from '@/widgets/person/UserChip.vue'
import { useMembers } from '@/modules/merge-requests/model/use-members'

const props = defineProps<{
  ownerId: string | null
  canEdit: boolean
  disabled?: boolean
  /**
   * The trigger's leading word. Defaults to "Owner"; the knowledge-health
   * bulk bar passes "Reassign", where the picker names an action over many
   * pages rather than the state of one.
   */
  label?: string
  /**
   * Emit even when the pick equals `ownerId`. On the page the current owner
   * is a fact and re-picking it changes nothing; in a bulk reassign
   * `ownerId` is only a placeholder and every pick is an instruction.
   */
  always?: boolean
}>()
const emit = defineEmits<{ change: [ownerId: string | null] }>()

const { t } = useI18n()
const { members, memberOf } = useMembers()

const owner = computed(() => memberOf(props.ownerId))
const open = ref(false)
const query = ref('')
watch(open, (v) => {
  if (!v) query.value = ''
})

const roster = computed(() => {
  const q = query.value.trim().toLowerCase()
  // Somebody who left the workspace can no longer own a page, and the API
  // refuses them; the roster shows who can be picked, not who exists.
  const active = members.value.filter((m) => !m.disabled)
  if (!q) return active
  return active.filter((m) => m.displayName.toLowerCase().includes(q) || m.email.toLowerCase().includes(q))
})

function pick(id: string | null) {
  open.value = false
  if (props.always || id !== props.ownerId) emit('change', id)
}
</script>

<template>
  <!-- Read-only: the owner as a person, or the word for nobody. -->
  <span v-if="!canEdit" class="inline-flex items-center gap-1.5 text-xs">
    <span class="text-muted-foreground">{{ t('verification.owner') }}</span>
    <UserChip v-if="ownerId" :user-id="ownerId" size="sm" />
    <span v-else class="text-muted-foreground">{{ t('verification.unowned') }}</span>
  </span>

  <Popover v-else v-model:open="open">
    <PopoverTrigger as-child>
      <button
        type="button"
        class="inline-flex h-6 max-w-full items-center gap-1 rounded-md border bg-background px-1.5 text-xs transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
        :disabled="disabled"
        :title="label ?? t('verification.changeOwner')"
        :aria-label="label ?? t('verification.changeOwner')"
      >
        <span class="text-muted-foreground">{{ label ?? t('verification.owner') }}</span>
        <!-- A bulk reassign has no current owner to show: the trigger is the verb alone. -->
        <template v-if="always" />
        <template v-else-if="ownerId">
          <UserAvatar :user-id="ownerId" :name="owner?.displayName" :src="owner?.avatarUrl ?? null" size="sm" />
          <span class="max-w-32 truncate">{{ owner?.displayName ?? ownerId.slice(0, 8) }}</span>
        </template>
        <template v-else>
          <UserRound class="size-3.5 text-muted-foreground/70" />
          <span class="text-muted-foreground">{{ t('verification.unowned') }}</span>
        </template>
        <ChevronDown class="size-3.5 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="end" class="w-72 p-1.5">
      <Input
        v-model="query"
        class="mb-1.5 h-8 text-sm"
        :placeholder="t('verification.searchMembers')"
        :aria-label="t('verification.searchMembers')"
        autofocus
      />
      <div class="quiet-scroll max-h-64 space-y-0.5 overflow-y-auto">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
          :class="ownerId === null ? 'bg-muted/70' : ''"
          @click="pick(null)"
        >
          <span class="grid size-5 place-items-center"><UserRound class="size-3.5 text-muted-foreground/70" /></span>
          <span class="text-muted-foreground">{{ t('verification.unowned') }}</span>
          <Check v-if="ownerId === null" class="ml-auto size-3.5 text-primary" />
        </button>
        <button
          v-for="m in roster"
          :key="m.userId"
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-muted"
          :class="ownerId === m.userId ? 'bg-muted/70' : ''"
          @click="pick(m.userId)"
        >
          <UserAvatar :user-id="m.userId" :name="m.displayName" :src="m.avatarUrl" size="sm" />
          <span class="truncate">{{ m.displayName }}</span>
          <Check v-if="ownerId === m.userId" class="ml-auto size-3.5 text-primary" />
        </button>
        <p v-if="roster.length === 0" class="px-2 py-3 text-center text-xs text-muted-foreground">
          {{ t('verification.noMembers') }}
        </p>
      </div>
    </PopoverContent>
  </Popover>
</template>
