<script setup lang="ts">
// AI settings (docs/features/12): the assistant layer made administrable —
// provider config, skills, MCP plugins, token usage and the call log.
//
// Tabs are hand-rolled (there is no shadcn Tabs component here) using the same
// role="tablist" + border-b-2 strip as MergeRequestsPage, and the active tab
// lives in the query string so a link can point at one.
import { useI18n } from 'vue-i18n'
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/stores/auth'
import AiConfigPanel from '@/components/ai/AiConfigPanel.vue'
import AiAgentsPanel from '@/components/ai/AiAgentsPanel.vue'
import AgentRunsPanel from '@/components/ai/AgentRunsPanel.vue'
import AiSkillsPanel from '@/components/ai/AiSkillsPanel.vue'
import AiPluginsPanel from '@/components/ai/AiPluginsPanel.vue'
import AiUsagePanel from '@/components/ai/AiUsagePanel.vue'
import AiLogsPanel from '@/components/ai/AiLogsPanel.vue'

const { t } = useI18n()

// `label` is a message key — resolved with t() where the tab renders.
const TABS = [
  { key: 'config', label: 'ai.tabConfig' },
  { key: 'agents', label: 'ai.tabAgents' },
  { key: 'runs', label: 'ai.tabRuns' },
  { key: 'skills', label: 'ai.tabSkills' },
  { key: 'plugins', label: 'ai.tabPlugins' },
  { key: 'usage', label: 'ai.tabUsage' },
  { key: 'logs', label: 'ai.tabLogs' },
] as const
type TabKey = (typeof TABS)[number]['key']

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// Every endpoint behind this page is @Access('admin', …) except the skill
// roster, so a non-admin is told plainly rather than shown a wall of 403s.
const canManage = computed(() => auth.canAdminWorkspace)

const tab = computed<TabKey>(() => {
  const q = route.query.tab
  return TABS.some((t) => t.key === q) ? (q as TabKey) : 'config'
})

function setTab(key: TabKey) {
  void router.replace({ query: { ...route.query, tab: key } })
}
</script>

<template>
  <!-- One measure for the whole page. Without it the tab strip and the tables
       ran the full column while the settings form stopped at 42rem, so every
       tab switch moved the right-hand edge. -->
  <div class="flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-5">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 class="font-display text-2xl font-bold tracking-tight">AI</h1>
        <p class="text-muted-foreground mt-0.5 text-sm">
          {{ t('ai.pageSubtitle') }}
        </p>
      </div>
      <Badge v-if="!canManage" variant="outline">{{ t('ai.readOnlyBadge') }}</Badge>
    </div>

    <div class="flex gap-0.5 overflow-x-auto border-b" role="tablist">
      <button
        v-for="tabDef in TABS"
        :key="tabDef.key"
        role="tab"
        :aria-selected="tab === tabDef.key"
        class="focus-visible:ring-ring rounded-t-sm border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors focus-visible:ring-2 focus-visible:outline-none"
        :class="
          tab === tabDef.key
            ? 'border-primary text-primary font-medium'
            : 'text-muted-foreground hover:text-foreground hover:border-border border-transparent'
        "
        @click="setTab(tabDef.key)"
      >
        {{ t(tabDef.label) }}
      </button>
    </div>

    <div class="min-h-0 flex-1">
      <AiConfigPanel v-if="tab === 'config'" :can-manage="canManage" />
      <AiAgentsPanel v-else-if="tab === 'agents'" :can-manage="canManage" />
      <AgentRunsPanel v-else-if="tab === 'runs'" />
      <AiSkillsPanel v-else-if="tab === 'skills'" :can-manage="canManage" />
      <AiPluginsPanel v-else-if="tab === 'plugins'" :can-manage="canManage" />
      <AiUsagePanel v-else-if="tab === 'usage'" :can-manage="canManage" />
      <AiLogsPanel v-else :can-manage="canManage" />
    </div>
  </div>
</template>
