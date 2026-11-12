<script setup lang="ts">
/**
 * "Overridden in: …" under a workspace setting a project may override (#928).
 * A workspace screen that showed only its own value would read as the rule
 * everywhere, while a project quietly follows another. Names only the
 * projects the reader may open (the API's filter) and renders nothing when
 * none overrides — which is every workspace until someone sets one.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useQuery } from '@tanstack/vue-query'
import type { ProjectSettingKey, ProjectSettingOverridesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

const props = defineProps<{ setting: ProjectSettingKey }>()
const { t } = useI18n()
const query = useQuery(apiQueryOptions('/v1/projects/setting-overrides', { query: { workspaceId: getWorkspaceId() } }))
const projects = computed(() =>
  ((query.data.value as ProjectSettingOverridesResponse | undefined)?.overrides ?? []).filter((p) => p.settings.includes(props.setting)),
)
</script>

<template>
  <p v-if="projects.length" class="kn-measure text-xs text-muted-foreground">
    {{ t('projectSettings.overriddenIn') }}
    <template v-for="(p, i) in projects" :key="p.projectId">
      <RouterLink :to="`/settings/projects/${p.projectId}/policies`" class="text-primary hover:underline">{{ p.name }}</RouterLink
      ><template v-if="i < projects.length - 1">, </template>
    </template>
  </p>
</template>
