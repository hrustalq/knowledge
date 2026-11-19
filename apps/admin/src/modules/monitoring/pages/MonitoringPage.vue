<script setup lang="ts">
/**
 * The monitoring view (#1238): every store probed, every BullMQ queue's
 * counts, the heartbeat of each long-running process and each sweeper's last
 * pass. `GET /v1/admin/health` reads all of it fresh; the page polls it while
 * the tab is visible. Status is a dot plus a word in the panel ramp: emerald,
 * amber and red belong to the indexing dot (DESIGN.md, the Reserved Signal Rule).
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useQuery } from '@tanstack/vue-query'
import { RefreshCw } from 'lucide-vue-next'
import type { AdminDependency, AdminProcess, AdminTick } from '@knowledge/contracts'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Button } from '@knowledge/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@knowledge/ui/table'
import { formatDuration, formatNumber, formatRelative, formatTime } from '@knowledge/contracts/format'
import { apiQueryOptions } from '@/shared/api/queries'

const REFRESH_MS = 10_000
const QUEUE_COLS = ['waiting', 'active', 'delayed', 'failed'] as const

const { t, locale } = useI18n()
const health = useQuery({ ...apiQueryOptions('/v1/admin/health'), staleTime: 0, refetchInterval: REFRESH_MS })
const data = computed(() => health.data.value)

type Tone = 'good' | 'bad' | 'late' | 'off'
const DOT: Record<Tone, string> = {
  good: 'bg-panel-tip',
  bad: 'bg-panel-caution',
  late: 'bg-panel-warning',
  off: 'bg-muted-foreground/40',
}
const WORD: Record<Tone, string> = {
  good: 'text-muted-foreground',
  bad: 'text-panel-caution-ink font-medium',
  late: 'text-panel-warning-ink font-medium',
  off: 'text-muted-foreground',
}

const depTone = (d: AdminDependency): Tone => (d.status === 'up' ? 'good' : d.status === 'down' ? 'bad' : 'off')
const liveCount = (p: AdminProcess) => p.instances.filter((i) => i.live).length
const processTone = (p: AdminProcess): Tone => (liveCount(p) ? 'good' : p.expected ? 'bad' : 'off')
const tickTone = (tick: AdminTick): Tone => (!tick.ok ? 'bad' : tick.late ? 'late' : 'good')

/** What needs a look. A non-zero failed count is shown, not counted: BullMQ keeps failed jobs, so it would never clear. */
const problems = computed(() => {
  const d = data.value
  if (!d) return 0
  return (
    d.dependencies.filter((x) => x.status === 'down').length +
    (d.processes ?? []).filter((p) => processTone(p) === 'bad').length +
    (d.ticks ?? []).filter((x) => tickTone(x) !== 'good').length
  )
})

/** A failed or late pass first: with thirty sweepers, the one that needs a look must not sit below the fold. */
const TONE_ORDER: Record<Tone, number> = { bad: 0, late: 1, good: 2, off: 3 }
const ticks = computed(() => [...(data.value?.ticks ?? [])].sort((a, b) => TONE_ORDER[tickTone(a)] - TONE_ORDER[tickTone(b)]))

const relative = (iso: string) => formatRelative(iso, locale.value)
const duration = (ms: number) => formatDuration(ms, locale.value)
const clock = (iso: string) => formatTime(iso, locale.value)
const count = (n: number) => formatNumber(n, locale.value)
</script>

<template>
  <PageLayout :title="t('admin.nav.monitoring')" :subtitle="t('admin.sections.monitoring')">
    <template #actions>
      <Button variant="outline" size="sm" :disabled="health.isFetching.value" @click="health.refetch()">
        <RefreshCw class="motion-safe:transition-transform" :class="health.isFetching.value && 'motion-safe:animate-spin'" aria-hidden="true" />
        {{ t('admin.monitoring.refresh') }}
      </Button>
    </template>
    <template #meta>
      <p v-if="data" class="text-caption flex flex-wrap items-center gap-x-2 gap-y-0.5" aria-live="polite">
        <span :class="problems ? 'text-panel-caution-ink font-medium' : 'text-foreground font-medium'">
          {{ problems ? t('admin.monitoring.problems', { n: problems }) : t('admin.monitoring.healthy') }}
        </span>
        <span class="text-muted-foreground">{{ t('admin.monitoring.checkedAt', { time: clock(data.checkedAt) }) }}</span>
        <span class="text-muted-foreground">{{ t('admin.monitoring.cadence') }}</span>
        <span v-if="health.isError.value" class="text-panel-caution-ink basis-full">
          {{ t('admin.monitoring.refreshFailed', { time: clock(data.checkedAt) }) }}
        </span>
      </p>
    </template>

    <PageState v-if="health.isPending.value" state="loading" :rows="10" row-class="h-9" />
    <PageState v-else-if="health.isError.value && !data" state="error" :error="health.error.value" />
    <template v-else-if="data">
      <!-- Stores -->
      <section class="space-y-2" aria-labelledby="mon-stores">
        <h2 id="mon-stores" class="font-display text-base font-semibold tracking-tight">{{ t('admin.monitoring.stores') }}</h2>
        <ul class="divide-y rounded-lg border">
          <li
            v-for="dep in data.dependencies"
            :key="dep.name"
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-3 py-2 sm:grid-cols-[auto_12rem_8rem_minmax(0,1fr)]"
          >
            <span class="size-1.5 translate-y-[-0.125rem] rounded-full" :class="DOT[depTone(dep)]" aria-hidden="true" />
            <span class="text-ui font-medium">{{ t(`admin.monitoring.deps.${dep.name}`) }}</span>
            <span class="text-ui justify-self-end sm:justify-self-start" :class="WORD[depTone(dep)]">
              {{ t(`admin.monitoring.status.${dep.status}`) }}
              <span v-if="dep.latencyMs !== null" class="text-muted-foreground font-normal tabular-nums">· {{ duration(dep.latencyMs) }}</span>
            </span>
            <span v-if="dep.error" class="text-caption text-muted-foreground col-start-2 col-end-4 font-mono break-all sm:col-start-4 sm:col-end-5">
              {{ dep.error }}
            </span>
          </li>
        </ul>
      </section>

      <!-- Processes -->
      <section class="space-y-2" aria-labelledby="mon-processes">
        <h2 id="mon-processes" class="font-display text-base font-semibold tracking-tight">{{ t('admin.monitoring.processes') }}</h2>
        <p v-if="!data.processes" class="text-ui text-panel-caution-ink rounded-lg border px-3 py-2">{{ t('admin.monitoring.redisUnread') }}</p>
        <ul v-else class="divide-y rounded-lg border">
          <li v-for="proc in data.processes" :key="proc.kind" class="grid grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-3 gap-y-0.5 px-3 py-2">
            <span class="size-1.5 translate-y-[-0.125rem] rounded-full" :class="DOT[processTone(proc)]" aria-hidden="true" />
            <div class="flex flex-wrap items-baseline justify-between gap-x-3">
              <span class="text-ui font-medium">{{ t(`admin.monitoring.kinds.${proc.kind}`) }}</span>
              <span class="text-ui" :class="WORD[processTone(proc)]">
                {{
                  liveCount(proc)
                    ? t('admin.monitoring.live', { n: liveCount(proc) })
                    : proc.expected
                      ? t('admin.monitoring.noneLive')
                      : t('admin.monitoring.notExpected')
                }}
              </span>
            </div>
            <ul v-if="proc.instances.length" class="col-start-2 space-y-0.5">
              <li v-for="inst in proc.instances" :key="`${inst.host}:${inst.pid}`" class="text-caption text-muted-foreground break-all">
                <span class="font-mono">{{ inst.host }}</span>
                · {{ t('admin.monitoring.version', { version: inst.version }) }}
                <span v-if="inst.version !== data.version" class="text-panel-warning-ink font-medium">
                  ({{ t('admin.monitoring.versionDiffers', { version: data.version }) }})
                </span>
                · {{ inst.live ? t('admin.monitoring.seen', { ago: relative(inst.lastSeenAt) }) : t('admin.monitoring.silent', { ago: relative(inst.lastSeenAt) }) }}
              </li>
            </ul>
          </li>
        </ul>
      </section>

      <!-- Queues -->
      <section class="space-y-2" aria-labelledby="mon-queues">
        <h2 id="mon-queues" class="font-display text-base font-semibold tracking-tight">{{ t('admin.monitoring.queues') }}</h2>
        <p v-if="data.queues.every((q) => !q.counts)" class="text-ui text-panel-caution-ink rounded-lg border px-3 py-2">
          {{ t('admin.monitoring.redisUnread') }}
        </p>
        <div v-else class="rounded-lg border">
          <Table class="text-ui" sticky-first>
            <TableHeader>
              <TableRow>
                <TableHead class="text-caption text-muted-foreground px-2 font-medium sm:px-3">{{ t('admin.monitoring.cols.queue') }}</TableHead>
                <TableHead
                  v-for="col in QUEUE_COLS"
                  :key="col"
                  class="text-caption text-muted-foreground px-2 text-right sm:px-3 font-medium"
                >
                  {{ t(`admin.monitoring.cols.${col}`) }}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow v-for="queue in data.queues" :key="queue.name">
                <TableCell class="px-2 font-mono sm:px-3">{{ queue.name }}</TableCell>
                <template v-if="queue.counts">
                  <TableCell
                    v-for="col in QUEUE_COLS"
                    :key="col"
                    class="px-2 text-right tabular-nums sm:px-3"
                    :class="!queue.counts[col] ? 'text-muted-foreground' : col === 'failed' && 'text-panel-caution-ink font-medium'"
                  >
                    {{ count(queue.counts[col]) }}
                  </TableCell>
                </template>
                <TableCell v-else colspan="4" class="text-panel-caution-ink px-2 text-right sm:px-3">{{ t('admin.monitoring.countsUnread') }}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>
      </section>

      <!-- Background tasks -->
      <section class="space-y-2" aria-labelledby="mon-tasks">
        <h2 id="mon-tasks" class="font-display flex items-baseline gap-2 text-base font-semibold tracking-tight">
          {{ t('admin.monitoring.tasks') }}
          <span v-if="data.ticks?.length" class="text-muted-foreground text-caption font-sans font-normal">{{ data.ticks.length }}</span>
        </h2>
        <p v-if="!data.ticks" class="text-ui text-panel-caution-ink rounded-lg border px-3 py-2">{{ t('admin.monitoring.redisUnread') }}</p>
        <p v-else-if="!data.ticks.length" class="text-ui text-muted-foreground rounded-lg border px-3 py-2">{{ t('admin.monitoring.noTicks') }}</p>
        <ul v-else class="divide-y rounded-lg border">
          <li
            v-for="tick in ticks"
            :key="`${tick.process}:${tick.name}`"
            class="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 gap-y-0.5 px-3 py-2"
          >
            <span class="size-1.5 translate-y-[-0.125rem] rounded-full" :class="DOT[tickTone(tick)]" aria-hidden="true" />
            <span class="text-ui font-mono font-medium break-all">{{ tick.name }}</span>
            <span class="text-ui" :class="WORD[tickTone(tick)]">
              {{ t(`admin.monitoring.status.${!tick.ok ? 'failed' : tick.late ? 'late' : 'ok'}`) }}
            </span>
            <span class="text-caption text-muted-foreground col-start-2 col-end-4 tabular-nums">
              {{ t(`admin.monitoring.kinds.${tick.process}`) }} · {{ relative(tick.lastAt) }} ·
              {{ t('admin.monitoring.took', { took: duration(tick.ms) }) }} ·
              {{ tick.intervalMs === null ? t('admin.monitoring.onDemand') : t('admin.monitoring.every', { interval: duration(tick.intervalMs) }) }}
            </span>
          </li>
        </ul>
      </section>
    </template>
  </PageLayout>
</template>
