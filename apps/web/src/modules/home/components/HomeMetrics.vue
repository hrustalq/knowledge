<script setup lang="ts">
// The home's numbers (#1243): one hairline strip, each cell a link to the list
// that number counts. A metric the caller may not see is absent, not a zero.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { HomeMetrics } from '@knowledge/contracts'
import { formatNumber, formatPercent } from '@/shared/utils/format'
import { VERIFICATION_MARK_CLASS } from '@/entities/document'

const props = defineProps<{ metrics: HomeMetrics }>()
const { t } = useI18n()

interface Cell {
  key: string
  label: string
  value: string
  hint: string
  to: string
  /** The verification diamond's fill (the tree's mark): decay reads as trust state, not as one more count. */
  mark?: string
  /** The value in the warning ink: something to act on. */
  warn?: boolean
}

const cells = computed<Cell[]>(() => {
  const m = props.metrics
  const n = (v: number) => formatNumber(v)
  const out: Cell[] = [{ key: 'pages', label: t('home.metrics.pages'), value: n(m.pages), hint: t('home.metrics.pagesHint'), to: '/documents' }]
  if (m.verified !== null) {
    out.push({
      key: 'verified',
      label: t('home.metrics.verified'),
      // Whole percent: a tenth is noise on a share people scan.
      value: formatPercent(m.pages === 0 ? 0 : Math.round((m.verified / m.pages) * 100) / 100),
      mark: 'bg-panel-tip',
      hint: t('home.metrics.verifiedHint', { n: n(m.verified) }, m.verified),
      to: '/knowledge-health',
    })
  }
  if (m.stale !== null) {
    out.push({
      key: 'stale',
      label: t('home.metrics.stale'),
      value: n(m.stale),
      hint: t('home.metrics.staleHint'),
      to: '/knowledge-health?filter=stale',
      mark: m.stale > 0 ? 'bg-panel-warning' : 'bg-muted-foreground/40',
      warn: m.stale > 0,
    })
  }
  if (m.openMergeRequests !== null) {
    out.push({
      key: 'mrs',
      label: t('home.metrics.openChanges'),
      value: n(m.openMergeRequests),
      hint: t('home.metrics.openChangesHint'),
      to: '/merge-requests',
    })
  }
  if (m.unansweredSearches !== null) {
    out.push({
      key: 'searches',
      label: t('home.metrics.unanswered'),
      value: n(m.unansweredSearches),
      hint: t('home.metrics.unansweredHint', { n: m.searchDays }),
      to: '/analytics',
    })
  }
  return out
})
</script>

<template>
  <!-- Hairlines are the 1px gaps over the border colour (the Hairline Rule): no
       card per number. Below `lg` two up, and an odd last cell takes the row. -->
  <ul
    class="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-border lg:grid-cols-[repeat(var(--cells),minmax(0,1fr))]"
    :style="{ '--cells': cells.length }"
  >
    <li
      v-for="(cell, i) in cells"
      :key="cell.key"
      :class="cells.length % 2 === 1 && i === cells.length - 1 ? 'col-span-2 lg:col-span-1' : ''"
    >
      <RouterLink
        :to="cell.to"
        class="group flex h-full flex-col gap-0.5 bg-card px-4 py-2.5 sm:gap-1 sm:py-3 transition-colors outline-none hover:bg-accent/40 focus-visible:relative focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span v-if="cell.mark" :class="[VERIFICATION_MARK_CLASS, cell.mark]" aria-hidden="true" />
          {{ cell.label }}
        </span>
        <!-- A deliberate step past the UI ramp: the value is the cell's whole point. Smaller on a phone, so the strip leaves room above the fold. -->
        <span class="text-xl font-semibold tracking-tight tabular-nums sm:text-2xl" :class="cell.warn ? 'text-panel-warning-ink' : ''">{{ cell.value }}</span>
        <span class="hidden text-caption text-muted-foreground group-hover:text-foreground sm:block">{{ cell.hint }}</span>
      </RouterLink>
    </li>
  </ul>
</template>
