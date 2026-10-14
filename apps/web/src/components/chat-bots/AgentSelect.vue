<script setup lang="ts">
/**
 * Which agent answers in a chat (issue #71). Offers the workspace's
 * conversational agents minus `author`: a chat turn is always Ask mode, where
 * the author — whose role is writing — falls back to the researcher anyway.
 * `null` is the inherited default, labelled by the caller.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import type { ListAiAgentChoicesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

const props = defineProps<{ defaultLabel: string; compact?: boolean }>()
const model = defineModel<string | null>({ default: null })
const { t } = useI18n()

/** reka-ui refuses an empty item value, so the inherited default needs a sentinel. */
const DEFAULT = '__default'
const query = useQuery(apiQueryOptions('/v1/ai/agents/choices', { query: { workspaceId: getWorkspaceId() } }))
const agents = computed(() =>
  ((query.data.value as ListAiAgentChoicesResponse | undefined)?.agents ?? []).filter(
    (a) => a.key !== 'author' && a.key !== 'researcher',
  ),
)
const value = computed({
  get: () => model.value ?? DEFAULT,
  set: (v: string) => (model.value = v === DEFAULT ? null : v),
})
</script>

<template>
  <Select v-model="value">
    <SelectTrigger class="w-full" :class="props.compact ? 'h-8 text-xs' : 'h-9'" :aria-label="t('chatBots.fields.agent')"><SelectValue /></SelectTrigger>
    <SelectContent>
      <SelectItem :value="DEFAULT">{{ props.defaultLabel }}</SelectItem>
      <SelectItem v-for="a in agents" :key="a.key" :value="a.key">{{ a.name }}</SelectItem>
      <!-- A key that is no longer offered (the agent was disabled) still reads as itself. -->
      <SelectItem v-if="model && !agents.some((a) => a.key === model)" :value="model">{{ model }}</SelectItem>
    </SelectContent>
  </Select>
</template>
