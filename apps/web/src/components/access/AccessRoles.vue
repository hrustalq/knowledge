<script setup lang="ts">
/**
 * What the three roles actually grant, and who holds each one.
 *
 * The roster already answers "what role does Alice have"; nothing answered the
 * question underneath it — "and what does that let her do". The vocabulary is
 * closed and cumulative (`ROLE_ORDER` in the API: viewer < editor < admin), so
 * the honest shape is a ladder rather than a matrix: each rung says what it
 * adds to the one below, and the summary line says so out loud.
 *
 * The bullets are transcribed from the `@Access` decorators, not from what the
 * roles sound like they should do, which is why two of them are surprising
 * enough to be called out under the list: an editor can merge, and a viewer can
 * comment and spend the workspace's AI budget. A page that described the roles
 * the way the names imply would be a page that lies.
 *
 * Trusted operator sits apart because it is not a rung. It is a flag on top of
 * admin gating exactly one route (`POST /v1/graph/query`), and putting it in
 * the ladder would imply a fourth, higher role.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ShieldCheck, Wrench } from 'lucide-vue-next'
import type { WorkspaceMemberEntry, WorkspaceRole } from '@knowledge/contracts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import UserChip from '@/components/people/UserChip.vue'

const { t } = useI18n()

const props = defineProps<{
  members: WorkspaceMemberEntry[]
  roles: readonly WorkspaceRole[]
  canManage: boolean
}>()

const emit = defineEmits<{ assign: [userIds: string[], role: WorkspaceRole] }>()

/**
 * Which capability keys each rung adds. Ids rather than sentences so the copy
 * stays in the message catalogs where the Russian half can keep up with it.
 */
const GRANTS: Record<WorkspaceRole, readonly string[]> = {
  viewer: ['read', 'comment', 'search', 'assistant', 'follow'],
  editor: ['pages', 'relations', 'merge', 'projects', 'automation'],
  admin: ['members', 'ai', 'integrations', 'housekeeping'],
}

/** Highest first: the ladder reads as "and on top of that…" going down. */
const ladder = computed(() => [...props.roles].reverse())

function membersOf(role: WorkspaceRole): WorkspaceMemberEntry[] {
  return props.members.filter((m) => m.role === role)
}

const operators = computed(() => props.members.filter((m) => m.trustedOperator))

/* --------------------------------------------------------------- reassigning */
/*
 * A set rather than a flag per row: moving six people to editor is one decision
 * taken once, and six separate role dropdowns is that decision taken six times
 * with a chance to misclick on each.
 */
const picked = ref<Set<string>>(new Set())
const pickedCount = computed(() => picked.value.size)

function toggle(userId: string, on: boolean) {
  const next = new Set(picked.value)
  if (on) next.add(userId)
  else next.delete(userId)
  picked.value = next
}

function assign(role: string) {
  if (!picked.value.size) return
  emit('assign', [...picked.value], role as WorkspaceRole)
  picked.value = new Set()
}
</script>

<template>
  <div class="space-y-4">
    <p class="text-muted-foreground max-w-[46rem] text-sm">{{ t('access.rolesHint') }}</p>

    <!-- The action bar holds its row whether or not anything is selected, so
         picking someone does not push the whole ladder down a line. -->
    <div
      v-if="canManage"
      class="flex h-9 flex-wrap items-center gap-2"
      :aria-hidden="pickedCount === 0"
    >
      <template v-if="pickedCount > 0">
        <span class="text-sm font-medium tabular-nums">
          {{ t('access.selectedCount', { n: pickedCount }) }}
        </span>
        <span class="text-muted-foreground text-sm">{{ t('access.changeRoleTo') }}</span>
        <Select @update:model-value="assign($event as string)">
          <SelectTrigger size="sm" class="w-36" :aria-label="t('access.changeRoleTo')">
            <SelectValue :placeholder="t('access.role')" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="r in roles" :key="r" :value="r">{{ t(`role.${r}`) }}</SelectItem>
          </SelectContent>
        </Select>
        <Button variant="ghost" size="sm" @click="picked = new Set()">
          {{ t('access.clearSelection') }}
        </Button>
      </template>
    </div>
    <p v-else class="text-muted-foreground text-sm">{{ t('access.rolesReadOnly') }}</p>

    <!-- One card, divided — not a card per role. Three bordered boxes side by
         side would read as three unrelated things, and the whole point is that
         each one contains the next. -->
    <div class="divide-y rounded-xl border bg-card">
      <section v-for="role in ladder" :key="role" class="px-5 py-4">
        <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h3 class="font-display text-[15px] font-semibold tracking-tight">
            {{ t(`role.${role}`) }}
          </h3>
          <span class="text-muted-foreground text-xs tabular-nums">
            {{ t('count.members', { n: membersOf(role).length }, membersOf(role).length) }}
          </span>
        </div>

        <ul class="text-muted-foreground mt-2 max-w-[46rem] space-y-1 text-sm">
          <li v-for="g in GRANTS[role]" :key="g" class="flex gap-2">
            <!-- A rule, not a bullet glyph: the list is a ladder rung's
                 contents, and a disc would pull the eye before the words. -->
            <span class="bg-border mt-2.5 h-px w-2.5 shrink-0" aria-hidden="true" />
            <span>{{ t(`access.grant.${role}.${g}`) }}</span>
          </li>
        </ul>

        <p v-if="membersOf(role).length === 0" class="text-muted-foreground mt-3 text-xs">
          {{ t('access.noMembersInRole') }}
        </p>
        <ul v-else class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
          <li
            v-for="member in membersOf(role)"
            :key="member.userId"
            class="flex items-center gap-1.5"
          >
            <Checkbox
              v-if="canManage"
              :model-value="picked.has(member.userId)"
              :aria-label="t('access.selectMember', { name: member.displayName })"
              @update:model-value="toggle(member.userId, $event === true)"
            />
            <UserChip :user-id="member.userId" :name="member.displayName" size="sm" />
            <Wrench
              v-if="member.trustedOperator"
              class="text-muted-foreground size-3"
              :aria-label="t('access.operatorTitle')"
            />
          </li>
        </ul>
      </section>
    </div>

    <!-- The two facts the role names get wrong. Stated where the roles are
         read, because this is exactly where somebody forms the wrong belief. -->
    <ul class="text-muted-foreground max-w-[46rem] space-y-1 text-xs">
      <li>{{ t('access.rolesNoteMerge') }}</li>
      <li>{{ t('access.rolesNoteViewer') }}</li>
    </ul>

    <!-- Apart from the ladder: a flag, not a fourth role. -->
    <section class="rounded-xl border bg-card px-5 py-4">
      <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 class="font-display text-[15px] font-semibold tracking-tight">
          {{ t('access.operatorTitle') }}
        </h3>
        <span class="text-muted-foreground text-xs tabular-nums">
          {{ t('count.members', { n: operators.length }, operators.length) }}
        </span>
      </div>
      <p class="text-muted-foreground mt-2 max-w-[46rem] text-sm">{{ t('access.operatorHint') }}</p>
      <p v-if="operators.length === 0" class="text-muted-foreground mt-3 text-xs">
        {{ t('access.operatorNone') }}
      </p>
      <ul v-else class="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        <li v-for="member in operators" :key="member.userId" class="flex items-center gap-1.5">
          <UserChip :user-id="member.userId" :name="member.displayName" size="sm" />
          <Badge v-if="member.role !== 'admin'" variant="outline">
            <ShieldCheck class="size-3" />
            {{ t(`role.${member.role}`) }}
          </Badge>
        </li>
      </ul>
    </section>
  </div>
</template>
