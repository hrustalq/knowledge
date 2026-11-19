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
import { Badge } from '@knowledge/ui/badge'
import { usePermission } from '@/stores/permissions'
import { useFeaturesStore } from '@/stores/features'
import { aiSectionLabel } from '@/modules/assistant/model/ai-sections'
import AiConfigPanel from '@/modules/assistant/components/AiConfigPanel.vue'
import AiCapturePanel from '@/modules/assistant/components/AiCapturePanel.vue'
import AiAgentsPanel from '@/modules/assistant/components/AiAgentsPanel.vue'
import ConfiguratorPanel from '@/modules/assistant/components/ConfiguratorPanel.vue'
import AgentRunsPanel from '@/modules/assistant/components/AgentRunsPanel.vue'
import AiCoveragePanel from '@/modules/assistant/components/AiCoveragePanel.vue'
import AiFeedbackPanel from '@/modules/assistant/components/AiFeedbackPanel.vue'
import AiSkillsPanel from '@/modules/assistant/components/AiSkillsPanel.vue'
import AiStyleguidePanel from '@/modules/assistant/components/AiStyleguidePanel.vue'
import AgentLearningsPanel from '@/modules/assistant/components/AgentLearningsPanel.vue'
import AiPluginsPanel from '@/modules/assistant/components/AiPluginsPanel.vue'
import AiUsagePanel from '@/modules/assistant/components/AiUsagePanel.vue'
import AiLogsPanel from '@/modules/assistant/components/AiLogsPanel.vue'

const { t } = useI18n()
const route = useRoute()

const section = computed(() => route.params.section as string)
const label = computed(() => aiSectionLabel(section.value))

// Every endpoint behind these panels is @Access('admin', …) except the skill
// roster, the styleguide (any member reads the rules they are held to) and the
// learnings list (any member reads; editors propose), so a non-admin is told plainly rather than shown a wall of 403s.
const canManage = usePermission('workspace:admin')
const features = useFeaturesStore()
</script>

<template>
  <!-- Fills the column. The measure lives in the one panel that is a form
       (AiConfigPanel); the tables and the usage chart spend the width they get. -->
  <div class="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ label ? t(label) : '' }}</h1>
      <Badge v-if="!canManage && section !== 'configurator'" variant="outline">{{ t('ai.readOnlyBadge') }}</Badge>
    </div>

    <div class="min-h-0 flex-1">
      <AiConfigPanel v-if="section === 'config'" :can-manage="canManage" />
      <AiCapturePanel v-else-if="section === 'capture'" :can-manage="canManage" />
      <AiAgentsPanel v-else-if="section === 'agents'" :can-manage="canManage" />
      <!-- Its own permission story: editors draft, the API checks the role on apply. Behind the `assistant`
           section, and v-if rather than v-feature: a hidden panel would still fetch and 404 (#604). -->
      <template v-else-if="section === 'configurator'">
        <ConfiguratorPanel v-if="features.isOn('assistant')" />
        <p v-else class="text-muted-foreground text-sm">{{ t('ai.configurator.assistantOff') }}</p>
      </template>
      <AgentRunsPanel v-else-if="section === 'runs'" />
      <AiCoveragePanel v-else-if="section === 'coverage'" :can-manage="canManage" />
      <AiFeedbackPanel v-else-if="section === 'feedback'" :can-manage="canManage" />
      <AiSkillsPanel v-else-if="section === 'skills'" :can-manage="canManage" />
      <AiStyleguidePanel v-else-if="section === 'styleguide'" :can-manage="canManage" />
      <AgentLearningsPanel v-else-if="section === 'learnings'" :can-manage="canManage" />
      <AiPluginsPanel v-else-if="section === 'plugins'" :can-manage="canManage" />
      <AiUsagePanel v-else-if="section === 'usage'" :can-manage="canManage" />
      <AiLogsPanel v-else-if="section === 'logs'" :can-manage="canManage" />
    </div>
  </div>
</template>
