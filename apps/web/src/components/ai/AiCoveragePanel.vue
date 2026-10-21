<script setup lang="ts">
// Coverage gaps (docs/features/38, phase 4): what people asked that the
// workspace could not answer, clustered by the surveyor into topics, each
// with the fix it proposes. The run proposes; every button here is a person
// acting on it — creating the drafted page, proposing the edit, or pointing
// the archaeologist at the code — through the same routes the Runs tab uses.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Clock, FilePlus2, GitPullRequest, Loader2, Pickaxe, Play, TriangleAlert } from 'lucide-vue-next'
import type { AgentFinding, AgentRunSummary, ListAgentRunsResponse, ListConnectorsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { labelFor } from '@/lib/labels'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import AiEmptyState from './AiEmptyState.vue'

const { t } = useI18n()

defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()

/**
 * The surveyor's runs only, newest first. The latest one is the page: a
 * finished run is the current picture, a running one shows its stage. Polled
 * while in flight, the Runs tab's rule.
 */
const query = useQuery({
  ...apiQueryOptions('/v1/ai/agents/runs', { query: { workspaceId, agentKey: 'surveyor' } }),
  refetchInterval: (q) => {
    const runs = (q.state.data as ListAgentRunsResponse | undefined)?.runs ?? []
    return runs.some((r) => r.status === 'pending' || r.status === 'running') ? 5_000 : false
  },
})
const runs = computed<AgentRunSummary[]>(() => (query.data.value as ListAgentRunsResponse | undefined)?.runs ?? [])
const latest = computed<AgentRunSummary | null>(() => runs.value[0] ?? null)
const inFlight = computed(() => latest.value?.status === 'pending' || latest.value?.status === 'running')
/** Only findings that stand on questions; anything else in the run is not a gap card. */
const gaps = computed(() => (latest.value?.findings ?? []).filter((f) => !!f.coverage))

const startRun = useApiMutation('post', '/v1/ai/agents/{key}/run', {
  invalidates: () => [['/v1/ai/agents'], ['/v1/ai/agents/runs']],
})
const createPage = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/create-page', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/documents']],
})
const proposeFinding = useApiMutation('post', '/v1/ai/agents/runs/{id}/findings/{index}/propose', {
  invalidates: () => [['/v1/ai/agents/runs'], ['/v1/merge-requests']],
})

/** Which finding is mid-flight, so only its own button spins. */
const busy = ref<string | null>(null)

/**
 * The repositories the archaeologist can read (docs/features/31): one is
 * implied, several need a pick, none means the button says what to connect.
 * The same rule the Agents tab applies to Run now.
 */
const connectorsQuery = useQuery(apiQueryOptions('/v1/connectors', { query: { workspaceId } }))
const repositories = computed(() =>
  ((connectorsQuery.data.value as ListConnectorsResponse | undefined)?.connectors ?? []).filter(
    (c) => c.enabled && c.kind === 'codebase',
  ),
)
const pickOpen = ref(false)
const pickTarget = ref<AgentFinding | null>(null)
const pickConnectorId = ref('')

async function survey() {
  try {
    await startRun.mutateAsync({ path: { key: 'surveyor' }, body: { workspaceId } })
    toast.success(t('ai.coverage.runStarted'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** Create page is offered to a draft that cites no page — the archaeologist's shape. */
function canDraft(f: AgentFinding): boolean {
  return !!f.draft && f.documentIds.length === 0 && !f.proposedAt
}
function canPropose(f: AgentFinding): boolean {
  return f.documentIds.length > 0 && !f.mergeRequestId && !f.proposedAt
}
function canExcavate(f: AgentFinding): boolean {
  return f.coverage?.recommendation === 'run-archaeologist'
}

async function draft(run: AgentRunSummary, index: number) {
  busy.value = `${run.id}:${index}`
  try {
    const res = (await createPage.mutateAsync({ path: { id: run.id, index }, query: { workspaceId } })) as {
      title: string
    }
    toast.success(t('ai.runs.pageCreated', { title: res.title }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = null
  }
}

async function propose(run: AgentRunSummary, index: number) {
  busy.value = `${run.id}:${index}`
  try {
    const res = (await proposeFinding.mutateAsync({ path: { id: run.id, index }, query: { workspaceId } })) as {
      title: string
    }
    toast.success(t('ai.runs.proposed', { title: res.title }))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = null
  }
}

/**
 * The note the archaeologist is started with: the topic and the questions,
 * so the run reads the code for what people actually asked. Capped at the
 * route's limit on `note`.
 */
function archaeologistNote(f: AgentFinding): string {
  const questions = (f.coverage?.questions ?? []).map((q) => `- ${q}`).join('\n')
  return `${t('ai.coverage.noteIntro', { topic: f.title })}\n${questions}`.slice(0, 2_000)
}

function excavate(f: AgentFinding) {
  if (repositories.value.length === 0) {
    toast.error(t('ai.agents.noRepositories'))
    return
  }
  if (repositories.value.length > 1) {
    pickTarget.value = f
    pickConnectorId.value = repositories.value[0].id
    pickOpen.value = true
    return
  }
  return startArchaeologist(f, repositories.value[0].id)
}

async function startArchaeologist(f: AgentFinding, connectorId: string) {
  busy.value = `arch:${f.title}`
  try {
    await startRun.mutateAsync({
      path: { key: 'archaeologist' },
      body: { workspaceId, connectorId, note: archaeologistNote(f) },
    })
    toast.success(t('ai.coverage.archaeologistStarted'))
    pickOpen.value = false
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = null
  }
}

const SIGNAL_KINDS = ['vote', 'low-confidence', 'no-answer'] as const
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground text-sm">{{ t('ai.coverage.subtitle') }}</p>
      <div class="flex items-center gap-2">
        <span v-if="latest && !inFlight" class="text-muted-foreground text-xs">
          {{ t('ai.coverage.lastRun', { when: relativeTime(latest.createdAt) }) }}
        </span>
        <Button v-if="canManage" size="sm" :disabled="inFlight || startRun.isPending.value" @click="survey">
          <Loader2 v-if="inFlight" class="size-3.5 animate-spin" />
          <Play v-else class="size-3.5" />
          {{ t('ai.coverage.run') }}
        </Button>
      </div>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-20 w-full" />
    </div>

    <AiEmptyState
      v-else-if="!latest"
      :icon="Clock"
      :title="t('ai.coverage.emptyTitle')"
      :body="t('ai.coverage.emptyBody')"
    />

    <template v-else>
      <!-- What the run is doing, while it does it (docs/features/29). -->
      <div v-if="inFlight" class="flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Loader2 class="size-4 animate-spin" />
        <span>{{ latest.stage ? labelFor(t, 'ai.runs.stage', latest.stage) : t('ai.runs.status.pending') }}</span>
        <span v-if="latest.progress !== null" class="bg-muted h-1 w-24 overflow-hidden rounded-full">
          <span class="bg-primary block h-full rounded-full transition-[width] duration-500" :style="{ width: `${Math.round(latest.progress * 100)}%` }" />
        </span>
      </div>

      <p v-else class="text-muted-foreground text-sm">{{ latest.summary || latest.error || t('ai.runs.noSummary') }}</p>

      <ul v-if="latest.warnings.length" class="space-y-1">
        <li v-for="(w, i) in latest.warnings" :key="i" class="flex gap-2 text-caption text-panel-warning-ink">
          <TriangleAlert class="mt-0.5 size-3 shrink-0" />
          <span>{{ w }}</span>
        </li>
      </ul>

      <AiEmptyState
        v-if="!inFlight && gaps.length === 0"
        :icon="Clock"
        :title="t('ai.coverage.noGapsTitle')"
        :body="t('ai.coverage.noGapsBody')"
      />

      <ul v-else class="grid gap-3 lg:grid-cols-2">
        <li v-for="f in gaps" :key="f.title" class="flex flex-col gap-2 rounded-md border p-3">
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0">
              <p class="font-medium">{{ f.title }}</p>
              <p class="text-muted-foreground mt-0.5 text-xs leading-relaxed">{{ f.detail }}</p>
            </div>
            <Badge variant="secondary" class="shrink-0 font-normal">
              {{ t('ai.coverage.questions', { count: f.coverage!.count }) }}
            </Badge>
          </div>

          <!-- The signal mix: how the questions arrived, and from where. -->
          <div class="flex flex-wrap gap-1">
            <template v-for="kind in SIGNAL_KINDS" :key="kind">
              <Badge v-if="f.coverage!.signals[kind]" variant="outline" class="font-normal">
                {{ t(`ai.coverage.signal.${kind}`, { count: f.coverage!.signals[kind] }) }}
              </Badge>
            </template>
            <Badge v-for="s in f.coverage!.surfaces" :key="s" variant="outline" class="text-muted-foreground font-normal">
              {{ labelFor(t, 'ai.coverage.surface', s) }}
            </Badge>
          </div>

          <ul class="space-y-0.5 text-xs">
            <li v-for="q in f.coverage!.questions" :key="q" class="text-muted-foreground truncate">“{{ q }}”</li>
          </ul>

          <p v-if="f.documentIds.length" class="flex flex-wrap gap-1 text-caption">
            <RouterLink v-for="(id, n) in f.documentIds" :key="id" :to="`/documents/${id}`" class="text-primary hover:underline">
              {{ f.documentTitles[n] ?? id }}
            </RouterLink>
          </p>

          <div class="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1">
            <span class="text-muted-foreground text-caption">
              {{ t(`ai.coverage.recommendation.${f.coverage!.recommendation}`) }}
            </span>
            <RouterLink
              v-if="f.mergeRequestId"
              :to="`/merge-requests/${f.mergeRequestId}`"
              class="text-primary inline-flex items-center gap-1 text-caption hover:underline"
            >
              <GitPullRequest class="size-3" /> {{ t('ai.runs.viewProposal') }}
            </RouterLink>
            <template v-else-if="canManage">
              <Button v-if="canDraft(f)" variant="outline" size="sm" :disabled="busy !== null" @click="draft(latest, latest.findings.indexOf(f))">
                <Loader2 v-if="busy === `${latest.id}:${latest.findings.indexOf(f)}`" class="size-3.5 animate-spin" />
                <FilePlus2 v-else class="size-3.5" />
                {{ t('ai.coverage.draftPage') }}
              </Button>
              <Button v-else-if="canPropose(f)" variant="outline" size="sm" :disabled="busy !== null" @click="propose(latest, latest.findings.indexOf(f))">
                <Loader2 v-if="busy === `${latest.id}:${latest.findings.indexOf(f)}`" class="size-3.5 animate-spin" />
                <GitPullRequest v-else class="size-3.5" />
                {{ t('ai.coverage.proposeUpdate') }}
              </Button>
              <Button
                v-else-if="canExcavate(f)"
                variant="outline"
                size="sm"
                :disabled="busy !== null || repositories.length === 0"
                :title="repositories.length === 0 ? t('ai.agents.noRepositories') : undefined"
                @click="excavate(f)"
              >
                <Loader2 v-if="busy === `arch:${f.title}`" class="size-3.5 animate-spin" />
                <Pickaxe v-else class="size-3.5" />
                {{ t('ai.coverage.runArchaeologist') }}
              </Button>
            </template>
          </div>
        </li>
      </ul>
    </template>

    <!-- Which repository the archaeologist reads — only when there is a real choice. -->
    <Dialog v-model:open="pickOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ t('ai.coverage.pickConnector') }}</DialogTitle>
          <DialogDescription>{{ t('ai.agents.pickConnectorHint') }}</DialogDescription>
        </DialogHeader>
        <Select v-model="pickConnectorId">
          <SelectTrigger :aria-label="t('connectors.pickConnector')"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem v-for="r in repositories" :key="r.id" :value="r.id">
              {{ r.name }} <span class="text-muted-foreground">· {{ r.config.repoUrl }}</span>
            </SelectItem>
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button variant="outline" @click="pickOpen = false">{{ t('common.cancel') }}</Button>
          <Button :disabled="!pickConnectorId || startRun.isPending.value" @click="pickTarget && startArchaeologist(pickTarget, pickConnectorId)">
            <Pickaxe class="size-3.5" /> {{ t('ai.coverage.runArchaeologist') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
