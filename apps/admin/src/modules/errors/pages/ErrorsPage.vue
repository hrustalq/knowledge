<script setup lang="ts">
/**
 * The errors list (#1240): every error-level log the platform recorded in
 * `ops_events`, grouped by a fingerprint the API derives when it reads (source,
 * logger context, the message with ids and numbers folded). A row is a group:
 * how often, since when, where. It opens its newest occurrence.
 *
 * Filtering happens API-side, since the table spans every workspace: the bar's
 * filters become query params, and the workspace options are the workspaces
 * the period's errors came from.
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { useInfiniteQuery } from '@tanstack/vue-query'
import { Calendar, CircleCheck, Cpu, Library, RefreshCw, SearchX, Text } from 'lucide-vue-next'
import { ADMIN_ERROR_PERIODS, OPS_PROCESS_KINDS, type AdminErrorGroup, type AdminErrorsResponse } from '@knowledge/contracts'
import { PageLayout, PageState } from '@knowledge/ui/layout'
import { Badge } from '@knowledge/ui/badge'
import { Button } from '@knowledge/ui/button'
import { FilterBar, type ActiveFilter, type FilterField } from '@knowledge/ui/filter-bar'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@knowledge/ui/table'
import { formatDateTime, formatNumber, formatRelative } from '@knowledge/contracts/format'
import { apiInfiniteQueryOptions } from '@/shared/api/queries'
import { processLabel, sourceLabel } from '../model/error'

const i18n = useI18n()
const { t, locale } = i18n

const filters = ref<ActiveFilter[]>([{ key: 'period', operator: 'is', values: ['24'] }])
const valuesOf = (key: string) => filters.value.find((f) => f.key === key)?.values ?? []

const query = computed(() => {
  const process = valuesOf('process')
  const workspaceId = valuesOf('workspace')
  const q = valuesOf('text')[0]?.trim()
  return {
    hours: Number(valuesOf('period')[0] ?? 24) as (typeof ADMIN_ERROR_PERIODS)[number],
    ...(process.length ? { process: process.join(',') } : {}),
    ...(workspaceId.length ? { workspaceId: workspaceId.join(',') } : {}),
    ...(q ? { q } : {}),
  }
})

const pages = useInfiniteQuery(computed(() => ({ ...apiInfiniteQueryOptions('/v1/admin/errors', { query: query.value }), staleTime: 0 })))
const first = computed<AdminErrorsResponse | undefined>(() => pages.data.value?.pages[0])
const groups = computed<AdminErrorGroup[]>(() => pages.data.value?.pages.flatMap((p) => p.groups) ?? [])

// Options outlive a refetch that narrows them: a chosen workspace stays nameable.
const workspaceNames = new Map<string, string>()
const fields = computed<FilterField[]>(() => {
  for (const w of first.value?.workspaces ?? []) workspaceNames.set(w.workspaceId, w.name)
  const counts = new Map((first.value?.workspaces ?? []).map((w) => [w.workspaceId, w.count]))
  return [
    {
      key: 'period',
      label: t('admin.errors.filter.period'),
      icon: Calendar,
      pinned: true,
      multiple: false,
      operators: ['is'],
      options: ADMIN_ERROR_PERIODS.map((h) => ({ value: String(h), label: t(`admin.errors.period.${h}`) })),
    },
    {
      key: 'process',
      label: t('admin.errors.filter.process'),
      icon: Cpu,
      operators: ['is'],
      options: OPS_PROCESS_KINDS.map((k) => ({ value: k, label: processLabel(k, i18n) })),
    },
    {
      key: 'workspace',
      label: t('admin.errors.filter.workspace'),
      icon: Library,
      operators: ['is'],
      options: [...workspaceNames].map(([value, label]) => ({ value, label, meta: counts.get(value) })),
    },
    {
      key: 'text',
      label: t('admin.errors.filter.text'),
      icon: Text,
      type: 'text',
      operators: ['contains'],
      placeholder: t('admin.errors.filter.textPlaceholder'),
    },
  ]
})

const filtered = computed(() => filters.value.some((f) => f.key !== 'period' && f.values.length))
const relative = (iso: string) => formatRelative(iso, locale.value)
const exact = (iso: string) => formatDateTime(iso, locale.value)
const where = (g: AdminErrorGroup) => [g.context, g.route ?? sourceLabel(g.source, i18n)].filter(Boolean).join(' · ')
</script>

<template>
  <PageLayout :title="t('admin.nav.errors')" :subtitle="t('admin.sections.errors')">
    <template #actions>
      <Button variant="outline" size="sm" :disabled="pages.isFetching.value" @click="pages.refetch()">
        <RefreshCw :class="pages.isFetching.value && 'motion-safe:animate-spin'" aria-hidden="true" />
        {{ t('admin.errors.refresh') }}
      </Button>
    </template>
    <template #meta>
      <p v-if="first" class="text-caption text-muted-foreground flex flex-wrap gap-x-2 gap-y-0.5">
        <span>{{ t('admin.errors.retention', { days: first.retentionDays }) }}</span>
        <span v-if="!first.recording" class="text-panel-warning-ink font-medium">{{ t('admin.errors.notRecording') }}</span>
      </p>
    </template>

    <div class="flex flex-wrap items-center justify-between gap-3">
      <FilterBar v-model="filters" :fields="fields" />
      <p v-if="first" class="text-muted-foreground text-caption tabular-nums" aria-live="polite">
        {{ pages.hasNextPage.value ? t('admin.errors.shownMore', { n: groups.length }) : t('admin.errors.shown', { n: groups.length }) }}
      </p>
    </div>

    <PageState v-if="pages.isPending.value" state="loading" :rows="8" row-class="h-12" />
    <PageState v-else-if="pages.isError.value && !first" state="error" :error="pages.error.value" />
    <PageState
      v-else-if="!groups.length && filtered"
      state="empty"
      :icon="SearchX"
      :title="t('admin.errors.noneMatch')"
      :description="t('admin.errors.noneMatchHint')"
    />
    <PageState
      v-else-if="!groups.length"
      state="empty"
      :icon="CircleCheck"
      :title="t('admin.errors.none')"
      :description="first?.recording === false ? t('admin.errors.noneNotRecording') : t('admin.errors.noneHint')"
    />
    <template v-else>
      <div class="rounded-lg border">
        <Table class="text-ui" sticky-first>
          <TableHeader>
            <TableRow>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.errors.cols.error') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground text-right font-medium">{{ t('admin.errors.cols.count') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.errors.cols.lastSeen') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.errors.cols.firstSeen') }}</TableHead>
              <TableHead class="text-caption text-muted-foreground font-medium">{{ t('admin.errors.cols.where') }}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow v-for="g in groups" :key="g.fingerprint">
              <TableCell class="max-w-[28rem] min-w-64">
                <RouterLink
                  :to="`/errors/${g.latestId}`"
                  class="decoration-primary/40 line-clamp-2 font-medium break-words underline-offset-4 hover:underline focus-visible:underline"
                  :title="g.message"
                >
                  {{ g.message || t('admin.errors.noMessage') }}
                </RouterLink>
                <span v-if="g.detail" class="text-caption mt-0.5 block truncate font-mono" :title="g.detail">{{ g.detail }}</span>
                <span class="text-muted-foreground text-caption mt-0.5 flex min-w-0 items-center gap-1.5">
                  <Badge v-if="g.level === 'fatal'" variant="destructive">{{ t('admin.errors.level.fatal') }}</Badge>
                  <span class="truncate">{{ where(g) }}</span>
                </span>
              </TableCell>
              <TableCell class="text-right font-medium tabular-nums">{{ formatNumber(g.count, locale) }}</TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap">
                <time :datetime="g.lastSeenAt" :title="exact(g.lastSeenAt)">{{ relative(g.lastSeenAt) }}</time>
              </TableCell>
              <TableCell class="text-muted-foreground whitespace-nowrap">
                <time :datetime="g.firstSeenAt" :title="exact(g.firstSeenAt)">{{ relative(g.firstSeenAt) }}</time>
              </TableCell>
              <TableCell class="text-muted-foreground min-w-40">
                {{ g.processes.map((p) => processLabel(p, i18n)).join(', ') }}
                <span v-if="g.workspaceCount" class="text-caption block">{{ t('admin.errors.workspaces', { n: g.workspaceCount }) }}</span>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <p class="text-muted-foreground text-caption">{{ t('admin.errors.countsInPeriod') }}</p>
      <div v-if="pages.hasNextPage.value" class="flex justify-center">
        <Button variant="outline" size="sm" :disabled="pages.isFetchingNextPage.value" @click="pages.fetchNextPage()">
          {{ pages.isFetchingNextPage.value ? t('admin.errors.loading') : t('admin.errors.loadMore') }}
        </Button>
      </div>
    </template>
  </PageLayout>
</template>
