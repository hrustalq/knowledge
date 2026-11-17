<script setup lang="ts">
// Which level of the project's methodology the next turn works at (#1128). The
// level's agent becomes the default and its guidance joins the prompt; the
// Ask/Agent toggle still decides what the turn may do.
//
// Hidden unless the chat is about a page in a project whose methodology
// declares levels: the API refuses a level anywhere else.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { Bot, Check, Layers } from 'lucide-vue-next'
import type { ListAiAgentChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { documentDetailQuery } from '@/entities/document'
import { Button } from '@knowledge/ui/button'
import { ResponsivePopover } from '@knowledge/ui/popover'

const { t } = useI18n()

const props = defineProps<{
  /** The page the chat is grounded on; no page, no picker. */
  documentId?: string
}>()

/** A level key, or null for none. */
const selected = defineModel<string | null>({ default: null })

const page = useQuery(
  computed(() => ({ ...documentDetailQuery(props.documentId ?? ''), enabled: !!props.documentId })),
)
const projectId = computed(() => (props.documentId ? (page.data.value?.document.projectId ?? null) : null))
const levelsQuery = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/projects/{id}/levels', { path: { id: projectId.value ?? '' } }),
    enabled: !!projectId.value,
  })),
)
const levels = computed(() => (projectId.value ? (levelsQuery.data.value?.levels ?? []) : []))

/** A remembered level the methodology no longer declares runs as none, so it reads as none. */
const current = computed(() => levels.value.find((l) => l.key === selected.value) ?? null)

// The agent a level brings (#1266), named from the same choices the agent picker reads. One the
// workspace switched off is not a choice, the turn falls back, so it is not named either.
const choices = useQuery(
  computed(() => ({ ...apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId: getWorkspaceId() } }), enabled: levels.value.length > 0 })),
)
const agentName = (key: string | null) =>
  key ? ((choices.data.value as ListAiAgentChoicesResponse | undefined)?.agents.find((a) => a.key === key)?.name ?? null) : null

/** The name of the picked level's agent when it is one a turn can run: the agent picker's "Default" shows it. */
const levelAgent = computed(() => agentName(current.value?.agent ?? null))

/** What the next turn sends: the picked level the methodology still declares, else none; undefined while there are no levels to pick. */
defineExpose({ turnLevel: () => (levels.value.length ? (current.value?.key ?? null) : undefined), levelAgent })
</script>

<template>
  <ResponsivePopover v-if="levels.length > 0" :title="t('chat.level.title')" :description="t('chat.level.hint')" panel-class="w-72 p-2">
    <template #trigger>
      <Button
        variant="ghost"
        size="sm"
        type="button"
        class="gap-1.5 text-xs"
        :aria-label="t('chat.level.label', { name: current?.name ?? t('chat.level.none') })"
      >
        <Layers class="size-3.5" aria-hidden="true" />
        <span class="max-w-28 truncate">{{ current?.name ?? t('chat.level.none') }}</span>
      </Button>
    </template>

    <ul class="max-h-80 space-y-0.5 overflow-y-auto">
      <li>
        <button
          type="button"
          class="hover:bg-accent flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left"
          :aria-pressed="!current"
          @click="selected = null"
        >
          <Check class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" :class="current ? 'opacity-0' : 'opacity-100'" />
          <span class="min-w-0">
            <span class="block text-sm">{{ t('chat.level.none') }}</span>
            <span class="text-muted-foreground block text-xs">{{ t('chat.level.noneHint') }}</span>
          </span>
        </button>
      </li>
      <li v-for="level in levels" :key="level.key">
        <button
          type="button"
          class="hover:bg-accent flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left"
          :aria-pressed="current?.key === level.key"
          @click="selected = level.key"
        >
          <Check class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" :class="current?.key === level.key ? 'opacity-100' : 'opacity-0'" />
          <span class="min-w-0">
            <span class="block text-sm wrap-break-word">{{ level.name }}</span>
            <span v-if="level.description" class="text-muted-foreground line-clamp-2 block text-xs">{{ level.description }}</span>
            <span v-if="agentName(level.agent)" class="text-muted-foreground mt-0.5 flex items-center gap-1 text-xs">
              <Bot class="size-3 shrink-0" aria-hidden="true" />
              <span class="truncate">{{ t('chat.level.agent', { name: agentName(level.agent) }) }}</span>
            </span>
          </span>
        </button>
      </li>
    </ul>
  </ResponsivePopover>
</template>
