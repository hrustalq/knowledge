<script setup lang="ts">
// Which agent takes the next turn (docs/features/20). Hidden entirely unless
// the workspace authored an agent of its own: with only the built-ins there is
// exactly one conversational candidate per mode, so a picker offering a single
// option would be furniture.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { Bot, Check } from 'lucide-vue-next'
import type { ListAiAgentChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@knowledge/ui/button'
import { ResponsivePopover } from '@knowledge/ui/popover'
import { MODE_AGENT_KEYS } from '../model/use-mode'

const { t } = useI18n()

/** '' = follow the mode (today's behaviour); 'auto' = let the router choose. */
const selected = defineModel<string>({ default: '' })

/** The chat level's agent by name (#1266): what "Default" runs while a level is picked. */
const props = defineProps<{ levelAgent?: string | null }>()

const query = useQuery(apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId: getWorkspaceId() } }))
const choices = computed(() => (query.data.value as ListAiAgentChoicesResponse | undefined)?.agents ?? [])

// A workspace that has added no agent of its own gets no picker at all.
const custom = computed(() => choices.value.filter((a) => !MODE_AGENT_KEYS.has(a.key)))

const levelAgentName = computed(() => props.levelAgent ?? null)

const label = computed(() => {
  if (!selected.value) return levelAgentName.value ?? t('chat.agent.default')
  if (selected.value === 'auto') return t('chat.agent.auto')
  return choices.value.find((a) => a.key === selected.value)?.name ?? selected.value
})

/** The chip shows a level's agent by name, as wide as "Default"; its accessible name says where it came from. */
const ariaName = computed(() =>
  !selected.value && levelAgentName.value ? t('chat.agent.fromLevel', { name: levelAgentName.value }) : label.value,
)

function pick(key: string) {
  selected.value = selected.value === key ? '' : key
}
</script>

<template>
  <ResponsivePopover
    v-if="custom.length > 0"
    :title="t('chat.agent.title')"
    :description="t('chat.agent.hint')"
    panel-class="w-72 p-2"
  >
    <template #trigger>
      <Button variant="ghost" size="sm" type="button" class="gap-1.5 text-xs" :aria-label="t('chat.agent.label', { name: ariaName })">
        <Bot class="size-3.5" aria-hidden="true" />
        <span class="max-w-28 truncate">{{ label }}</span>
      </Button>
    </template>

    <ul class="space-y-0.5">
      <li v-for="option in [{ key: '', name: t('chat.agent.default'), description: levelAgentName ? t('chat.agent.levelHint', { name: levelAgentName }) : t('chat.agent.defaultHint') },
                            { key: 'auto', name: t('chat.agent.auto'), description: t('chat.agent.autoHint') },
                            ...custom]"
          :key="option.key">
        <button
          type="button"
          class="hover:bg-accent flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left"
          :aria-pressed="selected === option.key"
          @click="pick(option.key)"
        >
          <Check class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" :class="selected === option.key ? 'opacity-100' : 'opacity-0'" />
          <span class="min-w-0">
            <span class="block text-sm">{{ option.name }}</span>
            <span class="text-muted-foreground block text-xs">{{ option.description }}</span>
          </span>
        </button>
      </li>
    </ul>
  </ResponsivePopover>
</template>
