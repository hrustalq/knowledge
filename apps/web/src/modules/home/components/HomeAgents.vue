<script setup lang="ts">
// What agents are doing now (#1243): name, stage and since when. No subject
// title: a run may read pages this reader cannot open.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { Bot } from 'lucide-vue-next'
import type { HomeResponse } from '@knowledge/contracts'
import { relativeTime } from '@/shared/api/api'
import { labelFor } from '@/shared/i18n/labels'

defineProps<{ data: NonNullable<HomeResponse['agents']> }>()
const { t } = useI18n()
</script>

<template>
  <p v-if="data.runs.length === 0" class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
    {{ data.queued ? t('home.agents.onlyQueued', { n: data.queued }, data.queued) : t('home.agents.empty') }}
  </p>
  <div v-else class="rounded-xl border bg-card">
    <ul class="divide-y">
      <li v-for="run in data.runs" :key="run.id" class="flex items-center gap-2 px-4 py-2.5 text-sm">
        <Bot class="size-3.5 shrink-0 text-panel-important-ink" aria-hidden="true" />
        <RouterLink :to="`/agents/runs/${run.id}`" class="min-w-0 flex-1 hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm">
          <span class="block truncate font-medium">{{ run.agentName }}</span>
          <span v-if="run.stage" class="block truncate text-xs text-muted-foreground">{{ labelFor(t, 'ai.runs.stage', run.stage) }}</span>
        </RouterLink>
        <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(run.startedAt) }}</span>
      </li>
    </ul>
    <p v-if="data.queued" class="border-t px-4 py-2 text-xs text-muted-foreground">
      {{ t('home.agents.queued', { n: data.queued }, data.queued) }}
    </p>
  </div>
</template>
