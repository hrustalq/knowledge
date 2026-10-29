<script setup lang="ts">
// Learnings (#70): corrections the team taught its agents.
//
// The review queue is the point of this panel. Anyone with edit rights may
// propose a learning — from a thread, from a dismissed finding, or here — and
// nothing proposed reaches a prompt. An admin reads the proposal, rewords it if
// needed, and approves it; from then on the agent is told it on every turn,
// newest first, up to the server's per-prompt limit, which is shown so a long
// active list is not mistaken for one that all applies.
//
// The learner (#305) adds two things an admin decides on here. A *derived*
// learning — the coach's draft from findings several people dismissed — is
// badged and shows its evidence, as far as the viewer may see it: the server
// titles a finding only when the viewer can open every page it cites, and the
// rest arrive as a bare count. And an active learning the learner found did
// not lower dismissals carries a proposed-archive flag with the counts behind
// it; the admin archives it or keeps it. Nothing here is decided by the server.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Archive, Check, GraduationCap, Pencil, Plus, RotateCcw, Sparkles, TriangleAlert } from 'lucide-vue-next'
import {
  AGENT_LEARNING_STATUSES,
  MCP_LEARNING_TARGET,
  type AgentLearningEvidenceFinding,
  type AgentLearningStatus,
  type AgentLearningSummary,
  type ListAgentLearningsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId, relativeTime } from '@/shared/api/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useAgentNames } from '@/modules/merge-requests/model/use-agent-names'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Skeleton } from '@/shared/ui/skeleton'
import { PageTabs, panelId, tabId, type PageTab } from '@/widgets/page'
import AiEmptyState from './AiEmptyState.vue'
import TeachAgentDialog from './TeachAgentDialog.vue'

defineProps<{ canManage: boolean }>()
const { t } = useI18n()

const workspaceId = getWorkspaceId()
const auth = useAuthStore()
const projects = useProjectsStore()
const { agentNames } = useAgentNames()

const query = useQuery(apiQueryOptions('/v1/ai/agents/learnings', { query: { workspaceId } }))
const data = computed(() => query.data.value as ListAgentLearningsResponse | undefined)
const all = computed(() => data.value?.learnings ?? [])

// Proposed first: it is the queue an admin opens this panel to work through.
const status = ref<AgentLearningStatus>('proposed')
const counts = computed(() =>
  Object.fromEntries(AGENT_LEARNING_STATUSES.map((s) => [s, all.value.filter((l) => l.status === s).length])),
)
const shown = computed(() => all.value.filter((l) => l.status === status.value))
const statusTabs = computed<PageTab<AgentLearningStatus>[]>(() =>
  AGENT_LEARNING_STATUSES.map((s) => ({ key: s, label: t(`ai.learnings.status.${s}`), count: counts.value[s] })),
)

const update = useApiMutation('patch', '/v1/ai/agents/learnings/{id}', {
  invalidates: () => [['/v1/ai/agents/learnings']],
})
const busy = ref<string | null>(null)

async function keep(learning: AgentLearningSummary) {
  busy.value = learning.id
  try {
    await update.mutateAsync({ path: { id: learning.id }, body: { keepActive: true } })
    toast.success(t('ai.learnings.kept'))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = null
  }
}

async function setStatus(learning: AgentLearningSummary, next: AgentLearningStatus) {
  busy.value = learning.id
  try {
    await update.mutateAsync({ path: { id: learning.id }, body: { status: next } })
    toast.success(t(`ai.learnings.moved.${next}`))
  } catch (e) {
    toast.error((e as Error).message)
  } finally {
    busy.value = null
  }
}

const dialogOpen = ref(false)
const editing = ref<AgentLearningSummary | null>(null)
function openNew() {
  editing.value = null
  dialogOpen.value = true
}
function openEdit(learning: AgentLearningSummary) {
  editing.value = learning
  dialogOpen.value = true
}

// `mcp` is a learning target, not an agent (#305): the agents list never names it.
const agentLabel = (key: string | null) =>
  key === MCP_LEARNING_TARGET ? t('ai.learnings.mcpTarget') : key ? (agentNames.value.get(key) ?? key) : t('ai.learnings.everyAgent')
const evidenceKey = (f: AgentLearningEvidenceFinding) =>
  'runId' in f ? `${f.runId}:${f.findingIndex}` : 'captureId' in f ? f.captureId : f.feedbackId
const projectLabel = (id: string | null) =>
  id ? (projects.items.find((p) => p.projectId === id)?.name ?? id) : t('ai.learnings.everyProject')

/** Where a learning came from, as a link when there is somewhere to go. */
function sourceLink(l: AgentLearningSummary): string | null {
  if (l.sourceKind === 'mr-thread' && l.sourceMergeRequestId) return `/merge-requests/${l.sourceMergeRequestId}`
  if (l.sourceKind === 'document-thread' && l.sourceDocumentId) return `/documents/${l.sourceDocumentId}`
  if (l.sourceKind === 'finding' || l.sourceKind === 'derived') return '/settings/ai/runs'
  return null
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <p class="text-muted-foreground max-w-2xl text-sm">
        {{ t('ai.learnings.subtitle', { limit: data?.promptLimit ?? 0 }) }}
      </p>
      <Button v-if="auth.canEdit && all.length > 0" size="sm" @click="openNew">
        <Plus class="size-3.5" /> {{ canManage ? t('ai.learnings.add') : t('ai.learnings.propose') }}
      </Button>
    </div>

    <div v-if="query.isPending.value" class="space-y-2">
      <Skeleton v-for="i in 3" :key="i" class="h-12 w-full" />
    </div>

    <AiEmptyState
      v-else-if="all.length === 0"
      :icon="GraduationCap"
      :title="t('ai.learnings.emptyTitle')"
      :body="t('ai.learnings.emptyBody')"
      :example="{ label: t('ai.forExample'), lines: [t('ai.learnings.example1'), t('ai.learnings.example2')] }"
    >
      <template #action>
        <Button v-if="auth.canEdit" size="sm" @click="openNew">
          <Plus class="size-3.5" /> {{ canManage ? t('ai.learnings.add') : t('ai.learnings.propose') }}
        </Button>
      </template>
    </AiEmptyState>

    <template v-else>
      <PageTabs v-model="status" :tabs="statusTabs" scope="learnings" :label="t('filters.status')" />

      <div :id="panelId(status, 'learnings')" role="tabpanel" :aria-labelledby="tabId(status, 'learnings')">
        <p v-if="shown.length === 0" class="text-muted-foreground py-6 text-center text-sm">
          {{ t(`ai.learnings.none.${status}`) }}
        </p>

        <ul v-else class="divide-y rounded-md border">
          <li v-for="l in shown" :key="l.id" class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
            <div class="min-w-0 flex-1">
              <p class="text-sm leading-relaxed whitespace-pre-wrap">{{ l.text }}</p>
              <p class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                <Badge
                  v-if="l.sourceKind === 'derived'"
                  variant="outline"
                  class="gap-1 font-normal"
                  :title="t('ai.learnings.derivedHint')"
                >
                  <Sparkles class="size-3" aria-hidden="true" /> {{ t('ai.learnings.derived') }}
                </Badge>
                <Badge variant="secondary" class="font-normal">{{ agentLabel(l.agentKey) }}</Badge>
                <Badge v-if="l.projectId" variant="outline" class="font-normal">{{ projectLabel(l.projectId) }}</Badge>
                <RouterLink v-if="sourceLink(l)" :to="sourceLink(l)!" class="text-primary hover:underline">
                  {{ t(`ai.learnings.source.${l.sourceKind}`) }}
                </RouterLink>
                <span v-else>{{ t(`ai.learnings.source.${l.sourceKind}`) }}</span>
                <span>· {{ relativeTime(l.createdAt) }}</span>
                <span v-if="l.status === 'active' && l.approvedAt">
                  · {{ t('ai.learnings.approvedAt', { time: relativeTime(l.approvedAt) }) }}
                </span>
              </p>

              <p v-if="l.sourceKind === 'derived' && l.status === 'proposed'" class="text-muted-foreground mt-1.5 text-xs">
                {{ t('ai.learnings.derivedHint') }}
              </p>

              <details v-if="l.evidence && l.evidenceCount > 0" class="mt-2">
                <summary class="text-muted-foreground cursor-pointer text-xs">
                  {{ t('ai.learnings.evidence', { n: l.evidenceCount }, l.evidenceCount) }}
                </summary>
                <ul class="mt-1.5 space-y-1 border-l pl-3">
                  <li
                    v-for="f in l.evidence.findings"
                    :key="evidenceKey(f)"
                    class="text-xs leading-relaxed"
                  >
                    <span class="text-foreground/90">{{ f.title }}</span>
                    <span class="text-muted-foreground">
                      · {{ agentLabel(f.agentKey) }}
                      <template v-if="f.dismissedAt">
                        · {{ t('ai.learnings.evidenceDismissed', { time: relativeTime(f.dismissedAt) }) }}
                      </template>
                    </span>
                  </li>
                  <li v-if="l.evidence.hidden > 0" class="text-muted-foreground text-xs">
                    {{ t('ai.learnings.evidenceHidden', { n: l.evidence.hidden }) }}
                  </li>
                </ul>
              </details>

              <div
                v-if="l.status === 'active' && l.archiveProposedAt"
                class="mt-2 flex gap-2 rounded-md border kn-callout-warning p-2 text-xs"
                role="note"
              >
                <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-panel-warning-ink" aria-hidden="true" />
                <div class="space-y-1">
                  <p class="font-medium">{{ t('ai.learnings.archiveProposed') }}</p>
                  <p v-if="l.archiveCheck" class="text-muted-foreground tabular-nums">
                    {{
                      t('ai.learnings.archiveCounts', {
                        beforeDismissed: l.archiveCheck.before.dismissed,
                        beforeFindings: l.archiveCheck.before.findings,
                        beforeRuns: l.archiveCheck.before.runs,
                        afterDismissed: l.archiveCheck.after.dismissed,
                        afterFindings: l.archiveCheck.after.findings,
                        afterRuns: l.archiveCheck.after.runs,
                      })
                    }}
                  </p>
                  <p class="text-muted-foreground">{{ t('ai.learnings.archiveProposedHint') }}</p>
                </div>
              </div>
            </div>

            <div v-if="canManage" class="flex shrink-0 flex-wrap gap-1">
              <Button
                v-if="l.status === 'proposed'"
                size="sm"
                :disabled="busy !== null"
                @click="setStatus(l, 'active')"
              >
                <Check class="size-3.5" /> {{ t('ai.learnings.approve') }}
              </Button>
              <Button
                v-if="l.status === 'active' && l.archiveProposedAt"
                variant="outline"
                size="sm"
                :disabled="busy !== null"
                @click="keep(l)"
              >
                <Check class="size-3.5" /> {{ t('ai.learnings.keep') }}
              </Button>
              <Button v-if="l.status !== 'archived'" variant="outline" size="sm" @click="openEdit(l)">
                <Pencil class="size-3.5" /> {{ t('common.edit') }}
              </Button>
              <Button
                v-if="l.status !== 'archived'"
                variant="ghost"
                size="sm"
                :disabled="busy !== null"
                @click="setStatus(l, 'archived')"
              >
                <Archive class="size-3.5" /> {{ t('ai.learnings.archive') }}
              </Button>
              <Button v-else variant="ghost" size="sm" :disabled="busy !== null" @click="setStatus(l, 'proposed')">
                <RotateCcw class="size-3.5" /> {{ t('ai.learnings.restore') }}
              </Button>
            </div>
          </li>
        </ul>
      </div>
    </template>

    <TeachAgentDialog v-model:open="dialogOpen" :learning="editing" />
  </div>
</template>
