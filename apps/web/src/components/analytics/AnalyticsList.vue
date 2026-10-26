<script setup lang="ts">
/**
 * One table of the workspace dashboard (#79) as a ranked list: a label (a page
 * link, a query, a tool) and its numbers in words, right-aligned. A list rather
 * than a `<table>` so it holds at a phone's width without a horizontal scroll.
 *
 * The header carries **Export CSV**, which downloads the whole table — up to
 * the API's export cap, not just the rows drawn here — through an authorised
 * fetch, since `<a href>` cannot carry the bearer.
 */
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { toast } from 'vue-sonner'
import { Download } from 'lucide-vue-next'
import type { AnalyticsReport, AnalyticsTrafficFilter } from '@knowledge/contracts'
import { errorMessage } from '@/api/errors'
import { requestFile } from '@/api/client'
import { saveFile } from '@/lib/api'
import { Button } from '@/components/ui/button'

export interface AnalyticsListRow {
  key: string
  label: string
  /** A page link; absent for a query or a tool. */
  to?: string
  /** The label is a stand-in (a redacted query, a deleted key): drawn quieter. */
  muted?: boolean
  meta: string
}

const props = defineProps<{
  title: string
  hint?: string
  rows: AnalyticsListRow[]
  empty: string
  report: AnalyticsReport
  /** The window the rows answer for, sent with the export so the file matches the screen. */
  params: { workspaceId: string; days: number; traffic?: AnalyticsTrafficFilter }
}>()

const { t } = useI18n()

const exporting = ref(false)
async function exportCsv() {
  exporting.value = true
  try {
    const { blob, filename } = await requestFile('get', '/v1/analytics/export.csv', {
      query: { ...props.params, report: props.report },
      config: { timeout: 0 },
    })
    saveFile(blob, filename ?? `${props.report}.csv`)
  } catch (e) {
    toast.error(errorMessage(e, t))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <section class="min-w-0 space-y-1.5" :aria-label="props.title">
    <div class="flex items-end justify-between gap-3">
      <div class="min-w-0">
        <h3 class="text-sm font-medium">{{ props.title }}</h3>
        <p v-if="props.hint" class="text-xs text-muted-foreground">{{ props.hint }}</p>
      </div>
      <Button
        variant="ghost"
        size="xs"
        class="shrink-0"
        :disabled="exporting || props.rows.length === 0"
        :aria-label="t('analytics.exportOf', { name: props.title })"
        @click="exportCsv"
      >
        <Download class="size-3.5" aria-hidden="true" />
        {{ exporting ? t('common.loading') : t('analytics.export') }}
      </Button>
    </div>
    <p v-if="props.rows.length === 0" class="rounded-lg border border-dashed px-3 py-3 text-sm text-muted-foreground">
      {{ props.empty }}
    </p>
    <ol v-else class="divide-y rounded-lg border bg-card">
      <li v-for="r in props.rows" :key="r.key" class="flex items-baseline gap-3 px-3 py-2 text-sm">
        <RouterLink v-if="r.to" :to="r.to" class="min-w-0 flex-1 truncate hover:underline">{{ r.label }}</RouterLink>
        <span v-else class="min-w-0 flex-1 truncate" :class="r.muted ? 'text-muted-foreground italic' : ''" :title="r.label">
          {{ r.label }}
        </span>
        <span class="shrink-0 text-xs text-muted-foreground tabular-nums">{{ r.meta }}</span>
      </li>
    </ol>
  </section>
</template>
