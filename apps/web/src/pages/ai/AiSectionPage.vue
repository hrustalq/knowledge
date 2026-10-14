<script setup lang="ts">
/**
 * One workspace-admin section of /settings/ai (issue #182): the pane beside the
 * rail. Connect is its own route (`ConnectAiPage`); everything else is a panel
 * behind `:section`, named by the same registry the rail reads.
 *
 * The section owns the `<h1>`. The rail already says "AI", so a page title here
 * would repeat it, and the reader's question at this point is which section they
 * are in — on a phone, where the rail is a scrolled strip, nothing else says.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/stores/auth'
import { aiSectionLabel } from '@/lib/ai-sections'
import AiConfigPanel from '@/components/ai/AiConfigPanel.vue'
import AiAgentsPanel from '@/components/ai/AiAgentsPanel.vue'
import AgentRunsPanel from '@/components/ai/AgentRunsPanel.vue'
import AiCoveragePanel from '@/components/ai/AiCoveragePanel.vue'
import AiFeedbackPanel from '@/components/ai/AiFeedbackPanel.vue'
import AiSkillsPanel from '@/components/ai/AiSkillsPanel.vue'
import AiPluginsPanel from '@/components/ai/AiPluginsPanel.vue'
import AiUsagePanel from '@/components/ai/AiUsagePanel.vue'
import AiLogsPanel from '@/components/ai/AiLogsPanel.vue'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()

const section = computed(() => route.params.section as string)
const label = computed(() => aiSectionLabel(section.value))

// Every endpoint behind these panels is @Access('admin', …) except the skill
// roster, so a non-admin is told plainly rather than shown a wall of 403s.
const canManage = computed(() => auth.canAdminWorkspace)
</script>

<template>
  <!-- Fills the column. The measure lives in the one panel that is a form
       (AiConfigPanel); the tables and the usage chart spend the width they get. -->
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ label ? t(label) : '' }}</h1>
      <Badge v-if="!canManage" variant="outline">{{ t('ai.readOnlyBadge') }}</Badge>
    </div>

    <div class="min-h-0 flex-1">
      <AiConfigPanel v-if="section === 'config'" :can-manage="canManage" />
      <AiAgentsPanel v-else-if="section === 'agents'" :can-manage="canManage" />
      <AgentRunsPanel v-else-if="section === 'runs'" />
      <AiCoveragePanel v-else-if="section === 'coverage'" :can-manage="canManage" />
      <AiFeedbackPanel v-else-if="section === 'feedback'" :can-manage="canManage" />
      <AiSkillsPanel v-else-if="section === 'skills'" :can-manage="canManage" />
      <AiPluginsPanel v-else-if="section === 'plugins'" :can-manage="canManage" />
      <AiUsagePanel v-else-if="section === 'usage'" :can-manage="canManage" />
      <AiLogsPanel v-else-if="section === 'logs'" :can-manage="canManage" />
    </div>
  </div>
</template>
