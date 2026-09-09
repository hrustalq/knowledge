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
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ResponsivePopover } from '@/components/ui/popover'

const { t } = useI18n()

/** '' = follow the mode (today's behaviour); 'auto' = let the router choose. */
const selected = defineModel<string>({ default: '' })

const query = useQuery(apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId: getWorkspaceId() } }))
const choices = computed(() => (query.data.value as ListAiAgentChoicesResponse | undefined)?.agents ?? [])

// The built-ins the server already offers by mode. A workspace that has added
// none of its own gets no picker at all.
const BUILT_IN = new Set(['researcher', 'author'])
const custom = computed(() => choices.value.filter((a) => !BUILT_IN.has(a.key)))

const label = computed(() => {
  if (!selected.value) return t('chat.agent.default')
  if (selected.value === 'auto') return t('chat.agent.auto')
  return choices.value.find((a) => a.key === selected.value)?.name ?? selected.value
})

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
      <Button variant="ghost" size="sm" type="button" class="gap-1.5 text-xs">
        <Bot class="size-3.5" />
        <span class="max-w-28 truncate">{{ label }}</span>
      </Button>
    </template>

    <ul class="space-y-0.5">
      <li v-for="option in [{ key: '', name: t('chat.agent.default'), description: t('chat.agent.defaultHint') },
                            { key: 'auto', name: t('chat.agent.auto'), description: t('chat.agent.autoHint') },
                            ...custom]"
          :key="option.key">
        <button
          type="button"
          class="hover:bg-accent flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left"
          @click="pick(option.key)"
        >
          <Check class="mt-0.5 size-3.5 shrink-0" :class="selected === option.key ? 'opacity-100' : 'opacity-0'" />
          <span class="min-w-0">
            <span class="block text-sm">{{ option.name }}</span>
            <span class="text-muted-foreground block text-xs">{{ option.description }}</span>
          </span>
        </button>
      </li>
    </ul>
  </ResponsivePopover>
</template>
