<script setup lang="ts">
// Learnings (#70): corrections the team taught its agents.
//
// The review queue is the point of this panel. Anyone with edit rights may
// propose a learning — from a thread, from a dismissed finding, or here — and
// nothing proposed reaches a prompt. An admin reads the proposal, rewords it if
// needed, and approves it; from then on the agent is told it on every turn,
// newest first, up to the server's per-prompt limit, which is shown so a long
// active list is not mistaken for one that all applies.
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import { Archive, Check, GraduationCap, Pencil, Plus, RotateCcw } from 'lucide-vue-next'
import {
  AGENT_LEARNING_STATUSES,
  type AgentLearningStatus,
  type AgentLearningSummary,
  type ListAgentLearningsResponse,
} from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/api/queries'
import { getWorkspaceId, relativeTime } from '@/lib/api'
import { useAuthStore } from '@/stores/auth'
import { useProjectsStore } from '@/stores/projects'
import { useAgentNames } from '@/components/merge-requests/use-agent-names'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
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

const update = useApiMutation('patch', '/v1/ai/agents/learnings/{id}', {
  invalidates: () => [['/v1/ai/agents/learnings']],
})
const busy = ref<string | null>(null)

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

const agentLabel = (key: string | null) => (key ? (agentNames.value.get(key) ?? key) : t('ai.learnings.everyAgent'))
const projectLabel = (id: string | null) =>
  id ? (projects.items.find((p) => p.projectId === id)?.name ?? id) : t('ai.learnings.everyProject')

/** Where a learning came from, as a link when there is somewhere to go. */
function sourceLink(l: AgentLearningSummary): string | null {
  if (l.sourceKind === 'mr-thread' && l.sourceMergeRequestId) return `/merge-requests/${l.sourceMergeRequestId}`
  if (l.sourceKind === 'document-thread' && l.sourceDocumentId) return `/documents/${l.sourceDocumentId}`
  if (l.sourceKind === 'finding') return '/settings/ai/runs'
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
      <!-- Hand-rolled tab strip (no tab library), the house pattern. -->
      <div role="tablist" class="flex flex-wrap gap-1">
        <button
          v-for="s in AGENT_LEARNING_STATUSES"
          :key="s"
          type="button"
          role="tab"
          :aria-selected="status === s"
          class="rounded-md px-2.5 py-1.5 text-sm transition-colors"
          :class="status === s ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80 hover:bg-accent'"
          @click="status = s"
        >
          {{ t(`ai.learnings.status.${s}`) }}
          <span class="text-muted-foreground ml-1 text-xs tabular-nums">{{ counts[s] }}</span>
        </button>
      </div>

      <p v-if="shown.length === 0" class="text-muted-foreground py-6 text-center text-sm">
        {{ t(`ai.learnings.none.${status}`) }}
      </p>

      <ul v-else class="divide-y rounded-md border">
        <li v-for="l in shown" :key="l.id" class="flex flex-col gap-2 p-3 sm:flex-row sm:items-start">
          <div class="min-w-0 flex-1">
            <p class="text-sm leading-relaxed whitespace-pre-wrap">{{ l.text }}</p>
            <p class="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
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
    </template>

    <TeachAgentDialog v-model:open="dialogOpen" :learning="editing" />
  </div>
</template>
