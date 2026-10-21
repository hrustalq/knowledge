<script setup lang="ts">
/**
 * The Agents tab of knowledge health (#305, phase 1): what became of each
 * agent's output. A finding is accepted when its proposal merged or it stood
 * unchallenged past the settle window, dismissed when a person dismissed it
 * or closed its proposal; an answer is accepted on an upvote and downvoted on
 * a downvote. Everything else is still pending.
 *
 * Every figure is the API's, derived on read. Below the run threshold a cell
 * is a raw count ("4 of 9"), never a percentage. The split control re-asks the
 * API per prompt hash or per model, so a changed prompt or a new model can be
 * compared against the one before it.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { Bot } from 'lucide-vue-next'
import { AGENT_OUTCOME_SPLITS, AGENT_OUTCOMES, type AgentOutcome, type AgentOutcomeGroup, type AgentOutcomeSplit, type AgentOutcomesResponse } from '@knowledge/contracts'
import { apiQueryOptions } from '@/api/queries'
import { formatDate, formatPercent } from '@/lib/format'
import { PageState } from '@/components/layout/page'
import { useAgentNames } from '@/components/merge-requests/use-agent-names'
import { outcomeShare, outcomesFor, shortHash, totalOf } from './agent-outcomes-ui'

const props = defineProps<{ workspaceId: string; projectId?: string; scopeLabel: string }>()

const { t } = useI18n()
const { agentNames } = useAgentNames()

const split = ref<AgentOutcomeSplit>('none')

const query = useQuery(
  computed(() =>
    apiQueryOptions('/v1/agent-outcomes', {
      query: {
        workspaceId: props.workspaceId,
        ...(props.projectId ? { projectId: props.projectId } : {}),
        ...(split.value !== 'none' ? { split: split.value } : {}),
      },
    }),
  ),
)
const data = computed(() => query.data.value as AgentOutcomesResponse | undefined)
const groups = computed(() => data.value?.groups ?? [])

function agentLabel(g: AgentOutcomeGroup): string {
  if (g.source === 'answer') return t('health.agents.answers')
  return g.agentKey ? (agentNames.value.get(g.agentKey) ?? g.agentKey) : t('health.agents.unknownAgent')
}

/** The split value of a row, or null when the table is not split. */
function splitLabel(g: AgentOutcomeGroup): string | null {
  if (split.value === 'prompt') return g.promptHash ? shortHash(g.promptHash) : t('health.agents.unattributed')
  if (split.value === 'model') return g.model ?? t('health.agents.unattributed')
  return null
}

function cell(g: AgentOutcomeGroup, o: AgentOutcome): string {
  if (!outcomesFor(g.source).includes(o)) return '—'
  const share = outcomeShare(g, o, data.value?.minRuns ?? 20)
  return share.kind === 'raw'
    ? t('health.agents.ofTotal', { count: share.count, total: share.total })
    : formatPercent(share.ratio)
}

function cellTitle(g: AgentOutcomeGroup, o: AgentOutcome): string | undefined {
  if (!outcomesFor(g.source).includes(o)) return undefined
  return t('health.agents.ofTotal', { count: g.counts[o], total: totalOf(g) })
}

const runsLabel = (g: AgentOutcomeGroup) =>
  g.source === 'answer' ? t('health.agents.votes', { n: g.runs }, g.runs) : t('health.agents.runs', { n: g.runs }, g.runs)
</script>

<template>
  <div class="flex min-w-0 flex-col gap-4">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div class="space-y-1">
        <h2 class="text-base font-semibold">{{ t('health.agents.title', { scope: scopeLabel }) }}</h2>
        <p class="max-w-2xl text-sm text-muted-foreground">
          {{ t('health.agents.hint', { days: data?.settleDays ?? 14, n: data?.minRuns ?? 20 }) }}
          <template v-if="data"> · {{ t('health.agents.since', { date: formatDate(data.since) }) }}</template>
        </p>
      </div>
      <!-- Hand-rolled, like the presets: three choices, one pressed. -->
      <div class="flex gap-1.5" role="group" :aria-label="t('health.agents.split.label')">
        <button
          v-for="s in AGENT_OUTCOME_SPLITS"
          :key="s"
          type="button"
          class="inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring"
          :class="split === s ? 'border-primary/40 bg-primary/10 text-primary' : 'bg-card text-muted-foreground hover:bg-muted hover:text-foreground'"
          :aria-pressed="split === s"
          @click="split = s"
        >
          {{ t(`health.agents.split.${s}`) }}
        </button>
      </div>
    </header>

    <PageState v-if="query.isPending.value" state="loading" :rows="3" row-class="h-10" />
    <PageState v-else-if="query.isError.value" state="error" :error="query.error.value" />
    <PageState
      v-else-if="groups.length === 0"
      state="empty"
      :icon="Bot"
      :title="t('health.agents.empty.title')"
      :description="t('health.agents.empty.body')"
    />

    <div v-else class="overflow-x-auto rounded-lg border bg-card">
      <table class="w-full min-w-[36rem] text-sm">
        <thead class="border-b text-xs text-muted-foreground">
          <tr>
            <th scope="col" class="px-3 py-2 text-left font-medium">{{ t('health.agents.column.agent') }}</th>
            <th scope="col" class="px-3 py-2 text-right font-medium">{{ t('health.agents.column.runs') }}</th>
            <th v-for="o in AGENT_OUTCOMES" :key="o" scope="col" class="px-3 py-2 text-right font-medium">
              {{ t(`health.agents.outcome.${o}`) }}
            </th>
          </tr>
        </thead>
        <tbody class="divide-y">
          <tr v-for="g in groups" :key="`${g.source}:${g.agentKey}:${g.promptHash}:${g.model}`">
            <th scope="row" class="px-3 py-2 text-left font-normal">
              <span class="block">{{ agentLabel(g) }}</span>
              <span v-if="splitLabel(g) !== null" class="block font-mono text-xs text-muted-foreground">{{ splitLabel(g) }}</span>
            </th>
            <td class="px-3 py-2 text-right text-muted-foreground tabular-nums">
              {{ runsLabel(g) }}
              <span v-if="g.runs < (data?.minRuns ?? 20)" class="block text-xs">{{ t('health.agents.fewRuns') }}</span>
            </td>
            <td
              v-for="o in AGENT_OUTCOMES"
              :key="o"
              class="px-3 py-2 text-right tabular-nums"
              :class="outcomesFor(g.source).includes(o) ? '' : 'text-muted-foreground'"
              :title="cellTitle(g, o)"
            >
              {{ cell(g, o) }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>
