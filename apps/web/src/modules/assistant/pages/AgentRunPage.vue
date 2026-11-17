<script setup lang="ts">
/**
 * One background agent run (#1247): what it is about, what it cost, its
 * findings with the list's verbs, and its step log — every model call, tool
 * call and warning, oldest first.
 *
 * Nothing here polls. The worker announces each step as `agent.run.step` and
 * the live cache refetches the log and the run (shared/api/live-cache.ts), so
 * a run left open fills in as it works. A private run (a memo's analysis, a
 * restricted project's check) is a 404 for anyone but its owner, here as in
 * the list.
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { CircleAlert, Cpu, Loader2, TriangleAlert, Wrench, XCircle } from 'lucide-vue-next'
import type { AgentRunStep, AgentRunSummary, DocumentDetailResponse, ListAgentRunStepsResponse } from '@knowledge/contracts'
import { apiInfiniteQueryOptions, apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId, relativeTime } from '@/shared/api/api'
import { formatCosts, formatDuration, formatNumber } from '@/shared/utils/format'
import { labelFor } from '@/shared/i18n/labels'
import { useAuthStore } from '@/stores/auth'
import { documentDetailQuery } from '@/entities/document'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { confirm } from '@knowledge/ui/confirm'
import { PageState } from '@knowledge/ui/layout'
import AgentRunFindings from '../components/AgentRunFindings.vue'
import { RUN_STATUS_ICON, isLiveRun, runStatusClass } from '../model/agent-run-ui'

const { t } = useI18n()
const route = useRoute()
const auth = useAuthStore()
const workspaceId = getWorkspaceId()
const runId = computed(() => String(route.params.id))

const runQuery = useQuery(
  computed(() => apiQueryOptions('/v1/ai/agents/runs/{id}', { path: { id: runId.value }, query: { workspaceId } })),
)
const run = computed(() => runQuery.data.value as AgentRunSummary | undefined)

const stepsQuery = useInfiniteQuery(
  computed(() => ({
    ...apiInfiniteQueryOptions('/v1/ai/agents/runs/{id}/steps', { path: { id: runId.value }, query: { workspaceId } }),
    enabled: !!run.value,
  })),
)
const pages = computed(() => (stepsQuery.data.value?.pages ?? []) as ListAgentRunStepsResponse[])
const steps = computed(() => pages.value.flatMap((p) => p.steps))
/** Every page answers with the run's spend so far; the latest one is the freshest. */
const usage = computed(() => pages.value.at(-1)?.usage ?? null)

/** What the run is about: a page (titled through the page query everyone shares) or a merge request. */
const subject = computed(() => {
  const [kind, id] = run.value?.subjectKey?.split(':') ?? []
  if (kind === 'doc' && id) return { to: `/documents/${id}`, docId: id }
  if (kind === 'mr' && id) return { to: `/merge-requests/${id}`, docId: null }
  return null
})
const subjectDoc = useQuery(
  computed(() => ({ ...documentDetailQuery(subject.value?.docId ?? ''), enabled: !!subject.value?.docId })),
)
const subjectLabel = computed(() =>
  subject.value?.docId
    ? ((subjectDoc.data.value as DocumentDetailResponse | undefined)?.document.title ?? t('ai.runs.page.subjectPage'))
    : t('ai.runs.page.subjectMergeRequest'),
)

const timing = computed(() => {
  const r = run.value
  if (!r) return ''
  if (!r.startedAt) return t('ai.runs.page.queued', { when: relativeTime(r.createdAt) })
  const started = t('ai.runs.page.started', { when: relativeTime(r.startedAt) })
  return r.finishedAt
    ? `${started} · ${t('ai.runs.page.took', { duration: formatDuration(Date.parse(r.finishedAt) - Date.parse(r.startedAt)) })}`
    : started
})

const spend = computed(() => {
  const u = usage.value
  if (!u || u.calls === 0) return ''
  const tokens = t('ai.runs.page.tokens', { n: formatNumber(u.totalTokens) }, u.totalTokens)
  return `${u.estimated ? '≈ ' : ''}${tokens}${u.costs.length ? ` · ${formatCosts(u.costs)}` : ''}`
})

const cancelRun = useApiMutation('post', '/v1/ai/agents/runs/{id}/cancel', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/ai/agents/runs/{id}']],
})
async function cancel() {
  const ok = await confirm({
    title: t('ai.runs.page.cancelTitle'),
    description: t('ai.runs.page.cancelBody'),
    action: t('ai.runs.page.cancel'),
    // Two buttons both reading "Cancel" would be a guess.
    cancel: t('ai.runs.page.keepRunning'),
    destructive: true,
  })
  if (!ok) return
  try {
    await cancelRun.mutateAsync({ path: { id: runId.value }, query: { workspaceId } })
    toast.success(t('ai.runs.page.cancelled'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

const STEP_ICON = { model: Cpu, tool: Wrench, warning: TriangleAlert } as const
const stepIcon = (s: AgentRunStep) => (s.ok ? STEP_ICON[s.kind] : CircleAlert)
const stepTone = (s: AgentRunStep) =>
  !s.ok ? 'text-destructive dark:text-destructive-foreground' : s.kind === 'warning' ? 'text-panel-warning-ink' : 'text-muted-foreground'
const stepMeta = (s: AgentRunStep) =>
  [
    s.tokens ? t('ai.runs.page.tokens', { n: formatNumber(s.tokens) }, s.tokens) : null,
    s.durationMs !== null ? formatDuration(s.durationMs) : null,
  ]
    .filter(Boolean)
    .join(' · ')
</script>

<template>
  <div class="flex w-full max-w-4xl flex-col gap-6">
    <PageState v-if="runQuery.isPending.value" state="loading" :rows="4" />
    <PageState v-else-if="runQuery.isError.value || !run" state="error" :error="runQuery.error.value" />

    <template v-else>
      <header class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0 space-y-1">
          <h1 class="font-display truncate text-2xl font-bold tracking-tight">{{ run.agentName }}</h1>
          <!-- The status is said, not only drawn. -->
          <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm">
            <component :is="RUN_STATUS_ICON[run.status]" class="size-4 shrink-0" :class="runStatusClass(run.status)" aria-hidden="true" />
            <span class="font-medium">{{ t(`ai.runs.status.${run.status}`) }}</span>
            <span class="text-muted-foreground">·</span>
            <Badge variant="secondary" class="font-normal">
              {{ run.input?.event ? t(`ai.triggers.events.${run.input.event.type}`) : t(`ai.runs.trigger.${run.trigger}`) }}
            </Badge>
            <RouterLink v-if="subject" :to="subject.to" class="text-primary max-w-72 truncate hover:underline">
              {{ subjectLabel }}
            </RouterLink>
            <Badge v-if="run.input?.pullRequest" variant="outline" class="max-w-72 font-normal">
              <span class="truncate">#{{ run.input.pullRequest.number }} {{ run.input.pullRequest.title }}</span>
            </Badge>
          </p>
          <p class="text-muted-foreground flex flex-wrap gap-x-1.5 text-xs tabular-nums">
            <span>{{ timing }}</span>
            <span v-if="run.model">· <span class="font-mono">{{ run.model }}</span></span>
            <span v-if="spend">· {{ spend }}</span>
          </p>
        </div>
        <Button
          v-if="auth.canEdit && isLiveRun(run.status)"
          variant="outline"
          size="sm"
          class="text-destructive hover:text-destructive"
          :disabled="cancelRun.isPending.value"
          @click="cancel"
        >
          <Loader2 v-if="cancelRun.isPending.value" class="size-3.5 animate-spin" />
          <XCircle v-else class="size-3.5" />
          {{ t('ai.runs.page.cancel') }}
        </Button>
      </header>

      <!-- Where it is (docs/features/29), while it is there. -->
      <div v-if="run.status === 'running' && run.stage" class="flex items-center gap-3">
        <span class="text-muted-foreground text-sm">{{ labelFor(t, 'ai.runs.stage', run.stage) }}</span>
        <span v-if="run.progress !== null" class="bg-muted h-1 w-32 overflow-hidden rounded-full">
          <span
            class="bg-primary block h-full rounded-full transition-[width] duration-500 motion-reduce:transition-none"
            :style="{ width: `${Math.round(run.progress * 100)}%` }"
          />
        </span>
      </div>
      <p v-else-if="run.status === 'pending' && run.queuedBehind" class="text-muted-foreground text-sm">
        {{ t('ai.runs.queuedBehind', { agent: run.queuedBehind.agentName }) }}
      </p>

      <p v-if="run.error" class="text-destructive bg-destructive/5 rounded-md border px-3 py-2 text-sm dark:text-destructive-foreground">
        {{ run.error }}
      </p>
      <p v-else-if="run.summary" class="max-w-prose text-sm leading-relaxed">{{ run.summary }}</p>

      <section v-if="run.findingCount" aria-labelledby="run-findings" class="rounded-md border">
        <h2 id="run-findings" class="px-3 py-2 text-sm font-semibold">
          {{ t('ai.runs.findings', { count: run.findingCount }) }}
        </h2>
        <AgentRunFindings :run="run" />
      </section>

      <section aria-labelledby="run-steps" class="space-y-2">
        <h2 id="run-steps" class="text-sm font-semibold">{{ t('ai.runs.page.steps') }}</h2>
        <PageState v-if="stepsQuery.isPending.value" state="loading" :rows="3" row-class="h-8" />
        <p v-else-if="steps.length === 0" class="text-muted-foreground text-sm">
          {{ isLiveRun(run.status) ? t('ai.runs.page.stepsEmptyLive') : t('ai.runs.page.stepsEmpty') }}
        </p>
        <ol v-else class="divide-y rounded-md border">
          <li v-for="s in steps" :key="s.id" class="flex gap-2.5 px-3 py-2">
            <component :is="stepIcon(s)" class="mt-0.5 size-3.5 shrink-0" :class="stepTone(s)" aria-hidden="true" />
            <div class="min-w-0 flex-1">
              <p class="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                <span class="min-w-0 text-sm">
                  <span class="sr-only">{{ t(`ai.runs.page.kind.${s.kind}`) }}{{ s.ok ? '' : `, ${t('ai.runs.page.failed')}` }}: </span>
                  <span v-if="s.kind === 'warning'" class="text-panel-warning-ink">{{ s.output }}</span>
                  <template v-else>
                    <span v-if="s.kind === 'model'" class="text-muted-foreground">{{ t('ai.runs.page.kind.model') }} · </span>
                    <span class="font-mono text-caption">{{ s.name }}</span>
                  </template>
                </span>
                <span class="text-muted-foreground shrink-0 text-caption tabular-nums">{{ stepMeta(s) }}</span>
              </p>
              <p v-if="s.args" class="text-muted-foreground truncate font-mono text-caption" :title="s.args">{{ s.args }}</p>
              <p v-if="s.sources.length" class="mt-0.5 flex flex-wrap gap-x-2">
                <RouterLink
                  v-for="p in s.sources"
                  :key="p.documentId"
                  :to="`/documents/${p.documentId}`"
                  class="text-primary text-caption hover:underline"
                >
                  {{ p.title || p.documentId }}
                </RouterLink>
              </p>
              <!-- What the tool handed the model, as text: the prefix keeps the
                   tool's own untrusted wrapper, and is never rendered as markup. -->
              <details v-if="s.kind !== 'warning' && s.output" class="mt-1">
                <summary class="text-muted-foreground hover:text-foreground cursor-pointer text-caption">
                  {{ s.ok ? t('ai.runs.page.output') : t('ai.runs.page.error') }}
                </summary>
                <pre class="bg-muted/50 mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-caption wrap-break-word whitespace-pre-wrap">{{ s.output }}</pre>
              </details>
            </div>
          </li>
        </ol>
        <Button
          v-if="stepsQuery.hasNextPage.value"
          variant="ghost"
          size="sm"
          :disabled="stepsQuery.isFetchingNextPage.value"
          @click="stepsQuery.fetchNextPage()"
        >
          <Loader2 v-if="stepsQuery.isFetchingNextPage.value" class="size-3.5 animate-spin" />
          {{ t('ai.runs.page.loadMore') }}
        </Button>
      </section>
    </template>
  </div>
</template>
