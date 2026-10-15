<script setup lang="ts">
/**
 * Agent guidance (#70): the repository's AGENTS.md / CLAUDE.md / .cursorrules…
 * become disabled skills after each sync. The card says which files are read,
 * how many skills came from this connector, and imports now on request — the
 * after-sync import rides a lossy event bus, so the button is also its retry.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Download } from 'lucide-vue-next'
import { GUIDANCE_FILE_PATTERNS, type ListAiSkillsResponse, type RepoGuidanceImportResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId } from '@/lib/api'
import { Button } from '@/components/ui/button'

const props = defineProps<{ connectorId: string }>()
const { t } = useI18n()

const workspaceId = getWorkspaceId()
const skillsQuery = useQuery(apiQueryOptions('/v1/ai/skills', { query: { workspaceId } }))
const imported = computed(() =>
  ((skillsQuery.data.value as ListAiSkillsResponse | undefined)?.skills ?? []).filter(
    (s) => s.source === 'repo' && s.sourceConnectorId === props.connectorId,
  ),
)

const importNow = useApiMutation('post', '/v1/connectors/{id}/guidance/import', { invalidates: () => [['/v1/ai/skills']] })
const last = ref<RepoGuidanceImportResponse | null>(null)

async function run() {
  try {
    const result = (await importNow.mutateAsync({ path: { id: props.connectorId } })) as RepoGuidanceImportResponse
    last.value = result
    toast.success(t('connectors.guidance.result', { ...result }))
  } catch (e) {
    toast.error((e as Error).message)
  }
}
</script>

<template>
  <div class="rounded-lg border p-4">
    <div class="mb-2 flex items-center justify-between gap-2">
      <h2 class="text-sm font-medium">{{ t('connectors.guidance.title') }}</h2>
      <Button size="sm" variant="outline" :disabled="importNow.isPending.value" @click="run">
        <Download class="size-3.5" /> {{ t('connectors.guidance.importNow') }}
      </Button>
    </div>
    <p class="text-muted-foreground text-xs">{{ t('connectors.guidance.body') }}</p>
    <p class="text-muted-foreground mt-2 font-mono text-[11px] leading-relaxed">{{ GUIDANCE_FILE_PATTERNS.join(' · ') }}</p>

    <p class="mt-3 text-sm">
      <template v-if="imported.length">
        {{ t('connectors.guidance.imported', { count: imported.length }, imported.length) }} ·
        <RouterLink to="/settings/ai/skills" class="text-primary hover:underline">{{ t('connectors.guidance.open') }}</RouterLink>
      </template>
      <span v-else class="text-muted-foreground text-xs">{{ t('connectors.guidance.none') }}</span>
    </p>

    <template v-if="last">
      <p v-if="last.truncated.length" class="text-muted-foreground mt-2 text-xs">
        {{ t('connectors.guidance.truncated', { paths: last.truncated.join(', ') }) }}
      </p>
      <p v-if="last.skipped.length" class="text-muted-foreground mt-1 text-xs">
        {{ t('connectors.guidance.skipped', { paths: last.skipped.map((s) => s.path).join(', ') }) }}
      </p>
    </template>
  </div>
</template>
