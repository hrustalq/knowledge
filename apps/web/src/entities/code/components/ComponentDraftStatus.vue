<script setup lang="ts">
/**
 * Where one "Document this component" run is (#236, phase 5): drafting in the
 * worker, then waiting for the API to open it as a merge request, then a link
 * to that merge request. Polled while it is still moving; the run is the only
 * record, so nothing here is kept past the page.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { GitPullRequest, Loader2 } from 'lucide-vue-next'
import type { AgentRunSummary } from '@knowledge/contracts'
import { apiQueryOptions } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'

const props = defineProps<{ runId: string }>()
const { t } = useI18n()

const POLL_MS = 4_000

const query = useQuery(
  computed(() => ({
    ...apiQueryOptions('/v1/ai/agents/runs/{id}', {
      path: { id: props.runId },
      query: { workspaceId: getWorkspaceId() },
    }),
    refetchInterval: (q: { state: { data: unknown } }) => (settled(q.state.data as AgentRunSummary | undefined) ? false : POLL_MS),
  })),
)
const run = computed(() => query.data.value as AgentRunSummary | undefined)
const mergeRequestId = computed(() => run.value?.findings.find((f) => f.mergeRequestId)?.mergeRequestId ?? null)

/** Nothing more will happen: it failed, or the API has acted on it — opened, or could not. */
function settled(r: AgentRunSummary | undefined): boolean {
  if (!r) return false
  if (r.status === 'failed' || r.status === 'cancelled') return true
  return r.status === 'succeeded' && (!!r.input?.publishedAt || r.findings.some((f) => f.mergeRequestId))
}
</script>

<template>
  <p v-if="mergeRequestId" class="flex items-center gap-1 text-xs">
    <GitPullRequest class="size-3.5 shrink-0" aria-hidden="true" />
    <RouterLink :to="`/merge-requests/${mergeRequestId}`" class="underline underline-offset-2 hover:text-foreground">
      {{ t('component.draft.review') }}
    </RouterLink>
  </p>
  <p v-else-if="run && (run.status === 'failed' || run.status === 'cancelled')" class="text-xs text-destructive">
    {{ run.error || t('component.draft.failed') }}
  </p>
  <p v-else-if="run && settled(run)" class="text-xs text-destructive">{{ t('component.draft.notOpened') }}</p>
  <p v-else class="flex items-center gap-1 text-xs text-muted-foreground" role="status">
    <Loader2 class="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
    {{ run?.status === 'succeeded' ? t('component.draft.opening') : t('component.draft.drafting') }}
  </p>
</template>
