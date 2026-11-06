<script setup lang="ts">
// Which model runs this thread (docs/features/12): the "In chat" models of every
// enabled provider, under who serves them.
//
// Hidden entirely when the workspace offers none: a picker with one option is
// noise, and most workspaces never leave the default.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Check, ChevronDown } from 'lucide-vue-next'
import type { AiModelChoice, ListAiModelChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { Button } from '@/shared/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/shared/ui/dropdown-menu'
import { useAssistantStore } from '@/entities/assistant/model/assistant.store'

const { t } = useI18n()

const assistant = useAssistantStore()

const query = useQuery(apiQueryOptions('/v1/ai/models/choices', { query: { workspaceId: getWorkspaceId() } }))
const choices = computed(() => (query.data.value as ListAiModelChoicesResponse | undefined)?.models ?? [])
const defaultModel = computed(() => (query.data.value as ListAiModelChoicesResponse | undefined)?.defaultModel ?? null)

const groups = computed(() => {
  const byProvider = new Map<string | null, AiModelChoice[]>()
  for (const choice of choices.value) byProvider.set(choice.providerName, [...(byProvider.get(choice.providerName) ?? []), choice])
  return [...byProvider.entries()]
    .map(([providerName, models]) => ({ providerName, models }))
    .sort((a, b) => (a.providerName ?? '').localeCompare(b.providerName ?? ''))
})

const pinned = computed(() => assistant.activeThread?.modelId ?? null)
// A pin the workspace no longer offers runs on the default, so that is what it says.
const label = computed(() => choices.value.find((c) => c.id === pinned.value)?.code ?? defaultModel.value ?? t('chat.modelDefault'))

async function pick(modelId: string | null) {
  const threadId = assistant.activeThread?.id
  if (!threadId) return
  try {
    await assistant.setThreadModel(threadId, modelId)
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <DropdownMenu v-if="choices.length > 0 && assistant.activeThread">
    <DropdownMenuTrigger as-child>
      <Button variant="ghost" size="sm" type="button" class="max-w-48 gap-1 text-xs" :aria-label="t('chat.modelForConversation')">
        <span class="truncate">{{ label }}</span>
        <ChevronDown class="size-3 shrink-0" />
      </Button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" class="max-h-80 w-64 overflow-y-auto">
      <DropdownMenuItem class="gap-2" @select="pick(null)">
        <Check v-show="!pinned" class="size-3.5 shrink-0" />
        <span :class="pinned && 'ml-[1.375rem]'">
          {{ t('chat.workspaceDefault') }}
          <span class="text-muted-foreground block break-all font-mono text-xs">{{ defaultModel ?? t('ai.configuredInSettings') }}</span>
        </span>
      </DropdownMenuItem>
      <template v-for="group in groups" :key="group.providerName ?? ''">
        <DropdownMenuLabel class="text-muted-foreground text-xs font-medium">{{ group.providerName ?? t('ai.default') }}</DropdownMenuLabel>
        <DropdownMenuItem v-for="c in group.models" :key="c.id" class="gap-2" @select="pick(c.id)">
          <Check v-show="pinned === c.id" class="size-3.5 shrink-0" />
          <span class="break-all font-mono text-xs" :class="pinned !== c.id && 'ml-[1.375rem]'">{{ c.code }}</span>
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
