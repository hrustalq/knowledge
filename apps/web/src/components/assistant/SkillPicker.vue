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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

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
  <DropdownMenu v-if="skills.length > 0">
    <DropdownMenuTrigger as-child>
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
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-72 p-2">
      <p class="text-muted-foreground px-1 pb-1.5 text-xs font-medium">Apply skills</p>
      <label
        v-for="skill in skills"
        :key="skill.id"
        class="hover:bg-accent flex cursor-pointer items-start gap-2 rounded-sm p-1.5"
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
      <p class="text-muted-foreground border-t px-1 pt-1.5 text-xs">
        Skills with matching trigger words apply on their own.
      </p>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
