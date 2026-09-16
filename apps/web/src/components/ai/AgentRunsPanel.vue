<script setup lang="ts">
// Background agent runs (docs/features/20). A run proposes; it never writes.
// The one action here is Propose, which opens a merge request against the page
// a finding cites — still not a change to the live page, just one a person can
// review and merge.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { CircleAlert, CircleCheck, Clock, GitPullRequest, Link2, Loader2, TriangleAlert } from 'lucide-vue-next'
import type { AgentFinding, AgentRunSummary, ListAgentRunsResponse } from '@knowledge/contracts'
import { toast } from 'vue-sonner'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { getWorkspaceId } from '@/lib/api'
import { relativeTime } from '@/lib/api'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { labelFor } from '@/lib/labels'
// The same chip the assistant cites with (docs/features/25). A finding's web
// sources are citations of exactly that kind, and rendering them a second way
// here would make one thing look like two.
import SourceChip from '@/components/assistant/SourceChip.vue'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

const workspaceId = getWorkspaceId()
const query = useQuery({
  ...apiQueryOptions('/v1/ai/agents/runs', { query: { workspaceId } }),
  // A run writes its stage as it goes (docs/features/29), which is only worth
  // anything if the page asks again. Polled while something is in flight and
  // not otherwise: a finished list is finished, and a background tab of settled
  // runs should not be re-fetching every five seconds forever.
  refetchInterval: (q) => {
    const runs = (q.state.data as ListAgentRunsResponse | undefined)?.runs ?? []
    return runs.some((r) => r.status === 'pending' || r.status === 'running') ? 5_000 : false
  },
})
const runs = computed<AgentRunSummary[]>(
  () => (query.data.value as ListAgentRunsResponse | undefined)?.runs ?? [],
)
const counts = computed(() => (query.data.value as ListAgentRunsResponse | undefined)?.counts)

const proposeFinding = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/propose', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/merge-requests']],
})
const applyRelations = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/apply-relations', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/merge-requests'], ['/v1/documents']],
})
/** Which finding is mid-flight, so only its own button spins. */
const proposing = ref<string | null>(null)

/**
 * Two verbs, because there are two kinds of fix.
 *
 * `propose` rewrites page prose, and the server refuses it for a finding whose
 * fix is a relation — an orphan page has nothing to rewrite. Those now have a
 * verb of their own: a finding that carries relations is *applied*, editing only
 * the page's frontmatter. Until this existed, an orphan finding could not be
 * acted on at all.
 */
function canPropose(f: AgentFinding): boolean {
  return !f.mergeRequestId && f.kind !== 'orphan' && f.kind !== 'relation' && f.documentIds.length > 0
}

function canApplyRelations(f: AgentFinding): boolean {
  return !f.mergeRequestId && (f.relations?.length ?? 0) > 0 && f.documentIds.length > 0
}

async function propose(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}`
  try {
    const res = await proposeFinding.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })
    toast.success(t('ai.runs.proposed', { title: (res as { title: string }).title }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

async function apply(run: AgentRunSummary, index: number) {
  proposing.value = `${run.id}:${index}`
  try {
    const res = (await applyRelations.mutateAsync({
      path: { id: run.id, index },
      query: { workspaceId },
    })) as { changed: boolean; title: string | null }
    // The page already declared everything the finding proposed — someone got
    // there first. Nothing was opened, and saying so beats a success toast
    // pointing at a merge request that does not exist.
    if (res.changed) toast.success(t('ai.runs.relationsApplied', { title: res.title ?? '' }))
    else toast.info(t('ai.runs.nothingToApply'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    proposing.value = null
  }
}

const expanded = ref<string | null>(null)
function toggle(id: string) {
  expanded.value = expanded.value === id ? null : id
}

const STATUS_ICON = {
  pending: Clock,
  running: Loader2,
  succeeded: CircleCheck,
  failed: CircleAlert,
  cancelled: CircleAlert,
} as const

const SEVERITY_ICON = { info: CircleCheck, warning: TriangleAlert, error: CircleAlert } as const
const severityClass = (f: AgentFinding) =>
  f.severity === 'error' ? 'text-destructive' : f.severity === 'warning' ? 'text-amber-600' : 'text-muted-foreground'
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.runs.subtitle') }}</p>
      <div v-if="counts" class="flex flex-wrap gap-1.5">
        <Badge v-for="(n, status) in counts" :key="status" variant="outline" class="font-normal">
          {{ t(`ai.runs.status.${status}`) }} {{ n }}
        </Badge>
      </div>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <AiEmptyState
      v-else-if="runs.length === 0"
      :icon="Clock"
      :title="t('ai.runs.emptyTitle')"
      :body="t('ai.runs.emptyBody')"
    />

    <ul v-else class="space-y-2">
      <li v-for="run in runs" :key="run.id" class="rounded-md border">
        <button class="flex w-full items-start gap-3 p-3 text-left" @click="toggle(run.id)">
          <component
            :is="STATUS_ICON[run.status]"
            class="mt-0.5 size-4 shrink-0"
            :class="[
              run.status === 'failed' && 'text-destructive',
              run.status === 'succeeded' && 'text-emerald-600',
              run.status === 'running' && 'animate-spin',
            ]"
          />
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="font-medium">{{ run.agentName }}</span>
              <Badge variant="secondary" class="font-normal">{{ t(`ai.runs.trigger.${run.trigger}`) }}</Badge>
              <span v-if="run.findingCount" class="text-muted-foreground text-xs">
                {{ t('ai.runs.findings', { count: run.findingCount }) }}
              </span>
            </span>
            <span class="text-muted-foreground mt-0.5 block text-xs">
              {{ run.summary || run.error || t('ai.runs.noSummary') }}
            </span>
            <!-- What it is doing, while it is doing it (docs/features/29).
                 Only while it runs: a finished run's last stage is noise next to
                 the summary, which says what it actually did. The stage is free
                 text from the executor, so it resolves through labelFor and
                 falls back to itself rather than rendering a message key. -->
            <span v-if="run.status === 'running' && run.stage" class="mt-1.5 flex items-center gap-2">
              <span class="text-muted-foreground text-[11px]">{{ labelFor(t, 'ai.runs.stage', run.stage) }}</span>
              <span v-if="run.progress !== null" class="bg-muted h-1 w-20 overflow-hidden rounded-full">
                <span
                  class="bg-primary block h-full rounded-full transition-[width] duration-500"
                  :style="{ width: `${Math.round(run.progress * 100)}%` }"
                />
              </span>
            </span>
          </span>
          <span class="text-muted-foreground shrink-0 text-xs">{{ relativeTime(run.createdAt) }}</span>
        </button>

        <!-- What degraded without failing the run (docs/features/29). On expand
             rather than in the row: it qualifies the findings, and a run that
             warned is still a run that succeeded — putting it in the row would
             read as a failure. -->
        <ul v-if="expanded === run.id && run.warnings.length" class="space-y-1 border-t px-3 py-2">
          <li v-for="(w, i) in run.warnings" :key="i" class="flex gap-2 text-[11px] text-amber-600">
            <TriangleAlert class="mt-0.5 size-3 shrink-0" />
            <span>{{ w }}</span>
          </li>
        </ul>

        <ul v-if="expanded === run.id && run.findings.length" class="space-y-2 border-t px-3 py-3">
          <li v-for="(f, i) in run.findings" :key="i" class="flex gap-2.5">
            <component :is="SEVERITY_ICON[f.severity]" class="mt-0.5 size-3.5 shrink-0" :class="severityClass(f)" />
            <div class="min-w-0">
              <p class="text-sm font-medium">{{ f.title }}</p>
              <p class="text-muted-foreground text-xs leading-relaxed">{{ f.detail }}</p>
              <!-- The citation is the point: a finding that names no page is
                   dropped server-side, so every one of these resolves. -->
              <p class="mt-1 flex flex-wrap gap-1">
                <RouterLink
                  v-for="(id, n) in f.documentIds"
                  :key="id"
                  :to="`/documents/${id}`"
                  class="text-primary text-[11px] hover:underline"
                >
                  {{ f.documentTitles[n] ?? id }}
                </RouterLink>
              </p>
              <!-- Pages on the open web the finding rests on (docs/features/29).
                   The same chip the assistant cites with, so one kind of thing
                   reads one way wherever it appears — and it carries its host
                   out loud, because clicking it leaves the product. -->
              <p v-if="f.sources?.length" class="mt-1 flex flex-wrap gap-1">
                <SourceChip v-for="s in f.sources" :key="s.url" :source="s" />
              </p>
            </div>
            <div class="ml-auto shrink-0">
              <!-- Already acted on: the link replaces the button, so the same
                   finding cannot open a second merge request. -->
              <RouterLink
                v-if="f.mergeRequestId"
                :to="`/merge-requests/${f.mergeRequestId}`"
                class="text-primary inline-flex items-center gap-1 text-[11px] hover:underline"
              >
                <GitPullRequest class="size-3" /> {{ t('ai.runs.viewProposal') }}
              </RouterLink>
              <Button
                v-else-if="canApplyRelations(f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="apply(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}`" class="size-3.5 animate-spin" />
                <Link2 v-else class="size-3.5" />
                {{ t('ai.runs.applyRelations') }}
              </Button>
              <Button
                v-else-if="canPropose(f)"
                variant="outline"
                size="sm"
                :disabled="proposing !== null"
                @click="propose(run, i)"
              >
                <Loader2 v-if="proposing === `${run.id}:${i}`" class="size-3.5 animate-spin" />
                <GitPullRequest v-else class="size-3.5" />
                {{ t('ai.runs.propose') }}
              </Button>
            </div>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>
