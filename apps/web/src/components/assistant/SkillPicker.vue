<script setup lang="ts">
// Applies workspace skills to the next turn. Skills also join a turn on their
// own when a trigger word matches, so this is the override for "use this one
// even though I did not say the magic word" — hence the hint in the footer.
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { Sparkles } from 'lucide-vue-next'
import type { ListAiSkillsResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ResponsivePopover } from '@/components/ui/popover'

const selected = defineModel<string[]>({ default: () => [] })

const query = useQuery(apiQueryOptions('/v1/ai/skills', { query: { workspaceId: getWorkspaceId() } }))
// Disabled skills are configuration, not choices — an admin turned them off.
const skills = computed(() =>
  ((query.data.value as ListAiSkillsResponse | undefined)?.skills ?? []).filter((s) => s.enabled),
)

function toggle(id: string, on: boolean) {
  selected.value = on ? [...new Set([...selected.value, id])] : selected.value.filter((s) => s !== id)
}
</script>

<template>
  <!-- A popover, not a dropdown menu: this is a multi-select that stays open
       while you tick rows, and a menu's items are meant to be chosen and
       dismissed. On a phone the same list arrives as a bottom sheet. -->
  <ResponsivePopover
    v-if="skills.length > 0"
    title="Apply skills"
    description="Skills with matching trigger words apply on their own."
    panel-class="w-72 p-2"
  >
    <template #trigger>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="gap-1.5"
        :class="selected.length > 0 && 'text-primary'"
        aria-label="Apply skills to this message"
      >
        <Sparkles class="size-4" />
        <span v-if="selected.length > 0" class="text-xs tabular-nums">{{ selected.length }}</span>
      </Button>
    </template>

    <template #default="{ compact }">
      <p v-if="!compact" class="text-muted-foreground px-1 pb-1.5 text-xs font-medium">Apply skills</p>
      <label
        v-for="skill in skills"
        :key="skill.id"
        class="hover:bg-accent flex cursor-pointer items-start gap-2 rounded-sm p-2 sm:p-1.5"
      >
        <Checkbox
          :model-value="selected.includes(skill.id)"
          @update:model-value="toggle(skill.id, $event === true)"
        />
        <span class="min-w-0">
          <span class="block text-sm">{{ skill.name }}</span>
          <span v-if="skill.description" class="text-muted-foreground block text-xs">{{ skill.description }}</span>
        </span>
      </label>
      <p v-if="!compact" class="text-muted-foreground border-t px-1 pt-1.5 text-xs">
        Skills with matching trigger words apply on their own.
      </p>
    </template>
  </ResponsivePopover>
</template>
