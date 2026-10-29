<script setup lang="ts">
// Token spend per user, with a daily bar chart (DailyBars).
import { useI18n } from 'vue-i18n'
import { computed, ref } from 'vue'
import { formatNumber } from '@/shared/utils/format'
import { useQuery } from '@tanstack/vue-query'
import { toast } from 'vue-sonner'
import type { AiBudgetInfo, AiUsageResponse, ListAiBudgetsResponse } from '@knowledge/contracts'
import { apiQueryOptions, useApiMutation } from '@/shared/api/queries'
import { getWorkspaceId } from '@/shared/api/api'
import { Badge } from '@/shared/ui/badge'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/shared/ui/table'
import { DailyBars } from '@/shared/ui/daily-bars'

const { t } = useI18n()

const props = defineProps<{ canManage: boolean }>()

const workspaceId = getWorkspaceId()
// Message keys, resolved with t() at the render site (docs/features/18).
const RANGES = [
  { days: 7, label: 'ai.range.d7' },
  { days: 30, label: 'ai.range.d30' },
  { days: 90, label: 'ai.range.d90' },
] as const
const days = ref<number>(30)
const groupBy = ref<'user' | 'model'>('user')

const from = computed(() => new Date(Date.now() - days.value * 24 * 3600_000).toISOString())

const usage = useQuery(
  computed(() =>
    apiQueryOptions('/v1/ai/usage', { query: { workspaceId, from: from.value, groupBy: groupBy.value } }),
  ),
)
const budgets = useQuery(apiQueryOptions('/v1/ai/budgets', { query: { workspaceId } }))

const data = computed(() => usage.data.value as AiUsageResponse | undefined)
const budgetData = computed(() => budgets.data.value as ListAiBudgetsResponse | undefined)

const setBudget = useApiMutation('put', '/v1/ai/budgets/{userId}', {
  invalidates: () => [['/v1/ai/budgets']],
})

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/**
 * Cost is stored in USD micros. A real charge below a cent must not print as
 * "$0.00" — that reads as "the assistant is free", which is the one thing this
 * number exists to disprove.
 */
function fmtCost(micros: number | null): string {
  if (micros === null) return '—'
  if (micros === 0) return '$0.00'
  if (micros < 10_000) return '<$0.01'
  return `$${(micros / 1_000_000).toFixed(2)}`
}

function pct(used: number, budget: number | null): number {
  if (!budget) return 0
  return Math.min(100, Math.round((used / budget) * 100))
}

// --- chart ------------------------------------------------------------------
const chartPoints = computed(() => (data.value?.series ?? []).map((p) => ({ date: p.date, values: [p.totalTokens], calls: p.calls })))
const callsOn = (date: string) => chartPoints.value.find((p) => p.date === date)?.calls ?? 0

const chartMax = computed(() => Math.max(...(data.value?.series ?? []).map((p) => p.totalTokens), 0))

const editingUser = ref<string | null>(null)
const budgetDraft = ref('')

function startEdit(row: AiBudgetInfo) {
  editingUser.value = row.userId
  budgetDraft.value = row.monthlyTokenBudget?.toString() ?? ''
}

async function saveBudget(userId: string) {
  const raw = budgetDraft.value.trim()
  const parsed = raw ? Number(raw) : null
  if (raw && !Number.isFinite(parsed)) {
    toast.error(t('ai.budgetMustBeNumber'))
    return
  }
  try {
    await setBudget.mutateAsync({ path: { userId }, body: { workspaceId, monthlyTokenBudget: parsed } })
    editingUser.value = null
    toast.success(t('ai.budgetUpdated'))
  } catch (e) {
    toast.error((e as Error).message)
  }
}

/** Usage buckets carry the display label; budget rows only have an id. */
function labelFor(userId: string): string {
  return data.value?.buckets.find((b) => b.key === userId)?.label ?? userId
}
</script>

<template>
  <div class="space-y-6">
    <!-- range + grouping -->
    <div class="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
      <div class="flex gap-1">
        <Button
          v-for="r in RANGES"
          :key="r.days"
          :variant="days === r.days ? 'secondary' : 'ghost'"
          size="sm"
          @click="days = r.days"
        >
          {{ t(r.label) }}
        </Button>
      </div>
      <div class="flex gap-1">
        <Button
          v-for="g in (['user', 'model'] as const)"
          :key="g"
          :variant="groupBy === g ? 'secondary' : 'ghost'"
          size="sm"
          class="capitalize"
          @click="groupBy = g"
        >
          {{ t(`ai.groupBy.${g}`) }}
        </Button>
      </div>
    </div>

    <div v-if="usage.isPending.value" class="space-y-6">
      <Skeleton class="h-14 w-full max-w-md" />
      <Skeleton class="h-24 w-full" />
      <Skeleton v-for="i in 3" :key="i" class="h-10 w-full" />
    </div>

    <template v-else-if="data">
      <p v-if="data.totals.calls === 0" class="text-muted-foreground py-10 text-center text-sm">
        {{ t('ai.noActivityDays', { n: days }, days) }}
      </p>

      <template v-else>
        <!-- Totals sit as one tight group, not four columns spread over the full
             width — at 1000px the labels drifted so far from each other they
             stopped reading as one summary. -->
        <dl class="flex flex-wrap gap-x-10 gap-y-4">
          <div>
            <dt class="text-muted-foreground text-xs">{{ t('ai.calls') }}</dt>
            <dd class="text-2xl font-semibold tabular-nums">{{ formatNumber(data.totals.calls) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">{{ t('ai.tokens') }}</dt>
            <dd class="text-2xl font-semibold tabular-nums">{{ fmtTokens(data.totals.totalTokens) }}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground text-xs">{{ t('ai.estimatedCost') }}</dt>
            <dd class="text-2xl font-semibold tabular-nums">{{ fmtCost(data.totals.costUsdMicros) }}</dd>
            <!-- Without this the total silently reads as the whole bill. -->
            <dd v-if="data.totals.unpricedCalls > 0" class="text-muted-foreground mt-0.5 text-xs">
              {{ t('ai.excludesCalls', { calls: t('count.calls', { n: data.totals.unpricedCalls }, data.totals.unpricedCalls) }) }}
            </dd>
          </div>
          <div v-if="data.totals.errors > 0">
            <dt class="text-muted-foreground text-xs">{{ t('ai.failed') }}</dt>
            <dd class="text-destructive text-2xl font-semibold tabular-nums">{{ data.totals.errors }}</dd>
          </div>
        </dl>

        <!-- daily tokens -->
        <div>
          <div class="mb-2 flex items-baseline justify-between">
            <p class="text-muted-foreground text-xs font-medium">{{ t('ai.tokensPerDay') }}</p>
            <p class="text-muted-foreground text-xs tabular-nums">{{ t('ai.peak', { value: fmtTokens(chartMax) }) }}</p>
          </div>
          <DailyBars
            :from="data.from"
            :to="data.to"
            :points="chartPoints"
            :segments="[{ class: 'bg-primary/60 hover:bg-primary' }]"
            :label="t('ai.tokensChartLabel', { n: days, peak: fmtTokens(chartMax) })"
            :point-title="
              (date, [tokens]) =>
                t('ai.chartPoint', {
                  date,
                  tokens: formatNumber(tokens),
                  calls: t('count.calls', { n: callsOn(date) }, callsOn(date)),
                })
            "
          />
        </div>

        <!-- breakdown -->
        <div>
          <p class="text-muted-foreground mb-2 text-xs font-medium">{{ t(`ai.breakdownBy.${groupBy}`) }}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{{ t(`ai.groupHead.${groupBy}`) }}</TableHead>
                <TableHead class="text-right">{{ t('ai.calls') }}</TableHead>
                <TableHead class="text-right">{{ t('ai.prompt') }}</TableHead>
                <TableHead class="text-right">{{ t('ai.completion') }}</TableHead>
                <TableHead class="text-right">{{ t('ai.total') }}</TableHead>
                <TableHead class="text-right">{{ t('ai.estCost') }}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="b in data.buckets" :key="b.key">
                <TableCell class="font-medium">
                  {{ b.label }}
                  <Badge v-if="b.errors > 0" variant="outline" class="text-destructive ml-1.5 font-normal">
                    {{ t('ai.nFailed', { n: b.errors }) }}
                  </Badge>
                </TableCell>
                <TableCell class="text-right tabular-nums">{{ b.calls }}</TableCell>
                <TableCell class="text-muted-foreground text-right tabular-nums">
                  {{ fmtTokens(b.promptTokens) }}
                </TableCell>
                <TableCell class="text-muted-foreground text-right tabular-nums">
                  {{ fmtTokens(b.completionTokens) }}
                </TableCell>
                <TableCell class="text-right font-medium tabular-nums">{{ fmtTokens(b.totalTokens) }}</TableCell>
                <TableCell class="text-right tabular-nums">{{ fmtCost(b.costUsdMicros) }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </template>
    </template>

    <!-- budgets -->
    <section v-if="budgetData" class="space-y-3 border-t pt-6">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-sm font-semibold">{{ t('ai.budgetsThisMonth') }}</h2>
        <Badge v-if="!budgetData.workspace.enforced" variant="outline" class="font-normal">
          {{ t('ai.notEnforced') }}
        </Badge>
      </div>

      <div v-if="budgetData.workspace.monthlyTokenBudget !== null" class="max-w-md space-y-1.5">
        <div class="flex justify-between text-xs">
          <span class="text-muted-foreground">{{ t('ai.workspace') }}</span>
          <span class="tabular-nums">
            {{ fmtTokens(budgetData.workspace.usedTokens) }} /
            {{ fmtTokens(budgetData.workspace.monthlyTokenBudget) }}
          </span>
        </div>
        <div class="bg-muted h-1.5 overflow-hidden rounded-full">
          <div
            class="h-full rounded-full transition-[width]"
            :class="
              pct(budgetData.workspace.usedTokens, budgetData.workspace.monthlyTokenBudget) >= 90
                ? 'bg-destructive'
                : 'bg-primary'
            "
            :style="{ width: `${pct(budgetData.workspace.usedTokens, budgetData.workspace.monthlyTokenBudget)}%` }"
          />
        </div>
      </div>

      <Table v-if="budgetData.users.length > 0">
        <TableHeader>
          <TableRow>
            <TableHead>{{ t('ai.user') }}</TableHead>
            <TableHead class="text-right">{{ t('ai.used') }}</TableHead>
            <TableHead class="w-64">{{ t('ai.monthlyBudget') }}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="row in budgetData.users" :key="row.userId">
            <TableCell class="font-medium">{{ labelFor(row.userId) }}</TableCell>
            <TableCell class="text-right tabular-nums">{{ fmtTokens(row.usedTokens) }}</TableCell>
            <TableCell>
              <div v-if="editingUser === row.userId" class="flex items-center gap-2">
                <Input v-model="budgetDraft" :placeholder="t('ai.unlimited')" class="h-8" />
                <Button size="sm" :disabled="setBudget.isPending.value" @click="saveBudget(row.userId)">{{ t('common.save') }}</Button>
                <Button size="sm" variant="ghost" @click="editingUser = null">{{ t('common.cancel') }}</Button>
              </div>
              <button
                v-else
                class="rounded-sm text-left text-sm"
                :class="canManage ? 'hover:text-primary' : 'cursor-default'"
                :disabled="!canManage"
                @click="startEdit(row)"
              >
                <span class="tabular-nums">
                  {{ row.monthlyTokenBudget === null ? t('ai.unlimited') : fmtTokens(row.monthlyTokenBudget) }}
                </span>
                <Badge v-if="row.overridden" variant="secondary" class="ml-1.5 font-normal">{{ t('ai.override') }}</Badge>
              </button>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
      <p v-else class="text-muted-foreground text-sm">
        {{ t('ai.noPerUserSpend') }}
      </p>
    </section>
  </div>
</template>
