<script setup lang="ts">
// Which provider profile runs this thread (docs/features/12).
//
// Hidden entirely when the workspace defines no profiles: a picker with one
// option is noise, and most workspaces never leave the default.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, ChevronDown } from 'lucide-vue-next'
import type { ListAiProviderChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAssistantStore } from '@/stores/assistant'

const { t } = useI18n()

const assistant = useAssistantStore()

const query = useQuery(apiQueryOptions('/v1/ai/providers/choices', { query: { workspaceId: getWorkspaceId() } }))
const choices = computed(() => (query.data.value as ListAiProviderChoicesResponse | undefined)?.providers ?? [])
const defaultId = computed(() => (query.data.value as ListAiProviderChoicesResponse | undefined)?.defaultProviderId)

const pinned = computed(() => assistant.activeThread?.providerId ?? null)
const label = computed(() => {
  if (!pinned.value) {
    const fallback = choices.value.find((c) => c.id === defaultId.value)
    return fallback ? fallback.name : 'Default'
  }
  return choices.value.find((c) => c.id === pinned.value)?.name ?? 'Default'
})

async function pick(providerId: string | null) {
  const threadId = assistant.activeThread?.id
  if (!threadId) return
  try {
    await assistant.setThreadProvider(threadId, providerId)
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <DropdownMenu v-if="choices.length > 0 && assistant.activeThread">
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="sm" type="button" class="gap-1 text-xs" :aria-label="t('chat.modelForConversation')">
        {{ label }}
        <ChevronDown class="size-3" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="w-60">
      <DropdownMenuItem class="gap-2" @select="pick(null)">
        <Check class="size-3.5" :class="!pinned && 'opacity-100'" v-show="!pinned" />
        <span :class="pinned && 'ml-[1.375rem]'">
          Workspace default
          <span class="text-muted-foreground block text-xs">
            {{ choices.find((c) => c.id === defaultId)?.model ?? 'configured in settings' }}
          </span>
        </span>
      </DropdownMenuItem>
      <DropdownMenuItem v-for="c in choices" :key="c.id" class="gap-2" @select="pick(c.id)">
        <Check v-show="pinned === c.id" class="size-3.5" />
        <span :class="pinned !== c.id && 'ml-[1.375rem]'">
          {{ c.name }}
          <span class="text-muted-foreground block font-mono text-xs">{{ c.model }}</span>
        </span>
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
