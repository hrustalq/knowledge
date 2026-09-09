<script setup lang="ts">
/**
 * A year of one person's work, as ink on paper.
 *
 * The reference is GitHub's contribution graph, and the departure from it is
 * deliberate. Green squares say "commits are good"; this product's question is
 * not how much someone produced but what the knowledge base got, and its one
 * accent already means structure. So the ramp is `--primary` at five densities
 * over the page ground — a day of writing is ink pressed into paper, an empty
 * day is bare paper inside a hairline. The reserved lifecycle colours
 * (emerald / amber / red) never appear here; they mean indexing, and a second
 * meaning would make the status dot unreadable.
 *
 * Weeks run Monday-first, not Sunday-first: the app ships English and Russian,
 * both of which start the week on Monday (`en-GB`, `ru-RU`), so following
 * GitHub here would have been a copy rather than a decision.
 *
 * Density is scaled to the busiest day in the window rather than to absolute
 * counts, so a quiet workspace and a loud one both read as a year of work
 * rather than as "empty" and "saturated".
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ActivityCalendarDay, ActivityCalendarResponse, ActivityKind } from '@knowledge/contracts'
import { ACTIVITY_KIND_STYLES } from '@/lib/activity-kinds'
import { formatDate } from '@/lib/format'

const props = defineProps<{
  calendar: ActivityCalendarResponse | null
  loading: boolean
  /** `YYYY-MM-DD`, or null when the whole window is showing. */
  selected: string | null
}>()
const emit = defineEmits<{ select: [string | null] }>()

const { t } = useI18n()

/** Cell 11px, gap 3px — the column pitch every label aligns to. */
const PITCH = 14
const CELL = 11

interface Cell {
  date: string
  total: number
  byKind: Record<ActivityKind, number> | null
  /** 0–4; 0 is bare paper. */
  step: number
  /** Column index, which is also the entrance's stagger index. */
  week: number
  /** True for days past `to` — the tail of the final week, drawn as nothing. */
  filler: boolean
}

function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const at = new Date(`${iso}T00:00:00.000Z`)
  at.setUTCDate(at.getUTCDate() + days)
  return dayKey(at)
}

/** Monday = 0 … Sunday = 6. */
function weekdayIndex(iso: string): number {
  return (new Date(`${iso}T00:00:00.000Z`).getUTCDay() + 6) % 7
}

/**
 * Four thresholds over the busiest day. `Math.max(1, …)` keeps them strictly
 * usable when the busiest day is 1 or 2 — without it every active day in a
 * quiet year would land on the top step and the ramp would carry no
 * information at all.
 */
function stepFor(total: number, busiest: number): number {
  if (total <= 0) return 0
  const q = Math.max(1, Math.ceil(busiest / 4))
  return Math.min(4, Math.ceil(total / q))
}

/** Rows are weekdays, columns are weeks — the DOM order screen readers get. */
const rows = computed<Cell[][]>(() => {
  const cal = props.calendar
  if (!cal) return []
  const byDate = new Map<string, ActivityCalendarDay>(cal.days.map((d) => [d.date, d]))
  // Back up to the Monday on or before `from` so column 0 is a whole week.
  const start = addDays(cal.from, -weekdayIndex(cal.from))
  const grid: Cell[][] = Array.from({ length: 7 }, () => [])

  for (let week = 0; ; week += 1) {
    const monday = addDays(start, week * 7)
    if (monday > cal.to) break
    for (let day = 0; day < 7; day += 1) {
      const date = addDays(monday, day)
      const hit = byDate.get(date)
      grid[day].push({
        date,
        total: hit?.total ?? 0,
        byKind: hit?.byKind ?? null,
        step: stepFor(hit?.total ?? 0, cal.busiestDay),
        week,
        filler: date < cal.from || date > cal.to,
      })
    }
  }
  return grid
})

const weekCount = computed(() => rows.value[0]?.length ?? 0)
const gridWidth = computed(() => weekCount.value * PITCH - (PITCH - CELL))

/** A label at each column where the month changes, positioned on the pitch. */
const monthLabels = computed(() => {
  const first = rows.value[0] ?? []
  const out: { week: number; label: string }[] = []
  let previous = ''
  first.forEach((cell, week) => {
    const month = cell.date.slice(0, 7)
    if (month === previous) return
    previous = month
    // Skip a label that would be clipped by the right edge.
    if (week > weekCount.value - 3) return
    out.push({
      week,
      label: new Intl.DateTimeFormat(locale.value === 'ru' ? 'ru-RU' : 'en-GB', {
        month: 'short',
        timeZone: 'UTC',
      }).format(new Date(`${cell.date}T00:00:00.000Z`)),
    })
  })
  return out
})

const { locale } = useI18n()

/** Mon / Wed / Fri carry the labels; the other rows keep their height. */
const WEEKDAY_ROWS = [0, 2, 4]
const weekdayLabels = computed(() =>
  Array.from({ length: 7 }, (_, i) =>
    WEEKDAY_ROWS.includes(i)
      ? new Intl.DateTimeFormat(locale.value === 'ru' ? 'ru-RU' : 'en-GB', {
          weekday: 'short',
          timeZone: 'UTC',
        })
          // 2024-01-01 was a Monday, so +i lands on the weekday this row shows.
          .format(new Date(`2024-01-0${1 + i}T00:00:00.000Z`))
      : '',
  ),
)

// --- readout -------------------------------------------------------------
// One shared floating card rather than 371 tooltip instances, and it follows
// focus as well as hover so the keyboard path shows the same thing the pointer
// does. `title` would have been free and is exactly the browser default this
// system themes away.

const active = ref<Cell | null>(null)
const readoutX = ref(0)
const readoutY = ref(0)
/** True when the card is drawn under the cell rather than over it. */
const readoutBelow = ref(false)

/** Readout box: min-width, and the margin it keeps from the ledger's edges. */
const READOUT_W = 144
const READOUT_H = 96

function show(cell: Cell, event: Event) {
  if (cell.filler) return
  const el = event.currentTarget as HTMLElement
  const box = el.getBoundingClientRect()
  const host = el.closest('[data-kn-ledger]')?.getBoundingClientRect()
  if (!host) return

  // Flip under the cell when there is not enough room above it. The top rows
  // of a seven-row grid sit right beneath the section heading, so a card that
  // always opened upward covered the year picker and spilled over the rail
  // beside it — which reads as breakage, not as a tooltip.
  readoutBelow.value = box.top - host.top < READOUT_H

  // Clamp to the ledger's own width so a cell near either end does not push
  // the card outside the card that contains it. The last column is exactly
  // where this component opens, so the right edge is the common case.
  const half = READOUT_W / 2
  const centre = box.left - host.left + box.width / 2
  readoutX.value = Math.min(Math.max(centre, half), Math.max(half, host.width - half))
  readoutY.value = readoutBelow.value ? box.bottom - host.top : box.top - host.top
  active.value = cell
}

function hide() {
  active.value = null
}

const readoutKinds = computed(() =>
  ACTIVITY_KIND_STYLES.map((style) => ({ ...style, n: active.value?.byKind?.[style.kind] ?? 0 })).filter(
    (k) => k.n > 0,
  ),
)

// --- keyboard ------------------------------------------------------------
// Roving tabindex: one cell in the tab order, arrows move within the grid.
// 371 individually tabbable cells would make the ledger a keyboard trap in
// everything but name.

const focused = ref<string | null>(null)
const scroller = ref<HTMLElement | null>(null)

const lastActive = computed(() => {
  const days = props.calendar?.days ?? []
  return days.length ? days[days.length - 1].date : (props.calendar?.to ?? null)
})

function isTabStop(cell: Cell): boolean {
  if (cell.filler) return false
  if (focused.value) return cell.date === focused.value
  if (props.selected) return cell.date === props.selected
  return cell.date === lastActive.value
}

function move(from: Cell, deltaDays: number, event: KeyboardEvent) {
  const cal = props.calendar
  if (!cal) return
  const next = addDays(from.date, deltaDays)
  if (next < cal.from || next > cal.to) return
  event.preventDefault()
  focused.value = next
  void nextTick(() => {
    const el = scroller.value?.querySelector<HTMLElement>(`[data-date="${next}"]`)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

function onKeydown(cell: Cell, event: KeyboardEvent) {
  switch (event.key) {
    case 'ArrowLeft':
      return move(cell, -7, event)
    case 'ArrowRight':
      return move(cell, 7, event)
    case 'ArrowUp':
      return move(cell, -1, event)
    case 'ArrowDown':
      return move(cell, 1, event)
    case 'Enter':
    case ' ':
      event.preventDefault()
      return toggle(cell)
    case 'Escape':
      if (props.selected) {
        event.preventDefault()
        emit('select', null)
      }
      return
  }
}

function toggle(cell: Cell) {
  if (cell.filler) return
  emit('select', props.selected === cell.date ? null : cell.date)
}

/**
 * Open on the present. A year of cells is wider than the column at every
 * breakpoint, and the end of the scroll is where the interesting part is —
 * arriving at January would make the page look empty for a person who has
 * been working all autumn.
 */
function scrollToEnd() {
  const el = scroller.value
  if (el) el.scrollLeft = el.scrollWidth
}
onMounted(scrollToEnd)
watch(() => props.calendar?.to, () => void nextTick(scrollToEnd))

const cellLabel = (cell: Cell) =>
  t('profile.ledger.cell', {
    n: cell.total,
    // `locale.value` is already read by the month/weekday formatters above, so
    // this component re-renders on a language switch and its dates follow.
    date: formatDate(`${cell.date}T00:00:00.000Z`),
  })
</script>

<template>
  <div data-kn-ledger class="relative">
    <!-- The weekday axis is pinned OUTSIDE the scroller. Inside it, scrolling
         to the present (which is where this opens) carried Mon/Wed/Fri off the
         left edge and left the grid with no vertical axis at all — the one
         reading position the component is guaranteed to start in. -->
    <div class="flex gap-2">
      <div class="flex shrink-0 flex-col gap-0.75 pt-8" aria-hidden="true">
        <span
          v-for="(label, i) in weekdayLabels"
          :key="i"
          class="flex items-center text-[10px] leading-none text-muted-foreground"
          :style="{ height: `${CELL}px` }"
        >{{ label }}</span>
      </div>

      <div ref="scroller" class="kn-ledger-scroll min-w-0 flex-1 overflow-x-auto pb-1">
        <div :style="{ width: `${gridWidth}px` }">
          <div class="relative h-4.5">
            <span
              v-for="m in monthLabels"
              :key="m.week"
              class="absolute top-0 text-[10px] leading-none text-muted-foreground"
              :style="{ left: `${m.week * PITCH}px` }"
            >{{ m.label }}</span>
          </div>

          <div
            role="grid"
            :aria-label="t('profile.ledger.gridLabel')"
            :aria-busy="loading || undefined"
            class="flex flex-col gap-[3px]"
            :class="loading ? 'opacity-50' : ''"
          >
            <div v-for="(row, r) in rows" :key="r" role="row" class="flex gap-[3px]">
              <button
                v-for="cell in row"
                :key="cell.date"
                role="gridcell"
                type="button"
                :data-date="cell.date"
                :tabindex="isTabStop(cell) ? 0 : -1"
                :disabled="cell.filler"
                :aria-selected="selected === cell.date"
                :aria-label="cell.filler ? undefined : cellLabel(cell)"
                :aria-hidden="cell.filler || undefined"
                class="kn-ledger-cell"
                :class="[
                  cell.filler ? 'kn-ledger-cell--filler' : '',
                  cell.step === 0 ? 'kn-ledger-cell--empty' : '',
                  selected === cell.date ? 'kn-ledger-cell--on' : '',
                ]"
                :style="{
                  '--kn-step': cell.step,
                  '--kn-week': cell.week,
                  width: `${CELL}px`,
                  height: `${CELL}px`,
                }"
                @click="toggle(cell)"
                @keydown="onKeydown(cell, $event)"
                @mouseenter="show(cell, $event)"
                @mouseleave="hide"
                @focus="show(cell, $event); focused = cell.date"
                @blur="hide"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Legend. The ramp is the only place the steps are named, so it carries
         the same five swatches the grid draws, in order. -->
    <div class="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2 text-[11px] text-muted-foreground">
      <span v-if="calendar">{{
        t('profile.ledger.busiest', { n: calendar.busiestDay })
      }}</span>
      <span class="ml-auto flex items-center gap-1.5">
        {{ t('profile.ledger.less') }}
        <span
          v-for="step in [0, 1, 2, 3, 4]"
          :key="step"
          class="kn-ledger-cell kn-ledger-cell--static"
          :class="step === 0 ? 'kn-ledger-cell--empty' : ''"
          :style="{ '--kn-step': step, width: '11px', height: '11px' }"
        />
        {{ t('profile.ledger.more') }}
      </span>
    </div>

    <!-- Readout: one card, driven by hover *and* focus. -->
    <Transition name="kn-fade">
      <div
        v-if="active && !active.filler"
        class="pointer-events-none absolute z-20 -translate-x-1/2"
        :class="readoutBelow ? 'pt-2' : '-translate-y-full pb-2'"
        :style="{ left: `${readoutX}px`, top: `${readoutY}px` }"
        role="status"
      >
        <div class="w-36 rounded-lg border bg-popover p-2.5 text-popover-foreground shadow-[0_16px_48px_-12px_rgb(0_0_0/0.2)]">
          <p class="text-xs font-medium">
            {{ t('profile.ledger.cellCount', { n: active.total }) }}
          </p>
          <p class="mt-0.5 text-[11px] text-muted-foreground">
            {{ (locale, formatDate(`${active.date}T00:00:00.000Z`)) }}
          </p>
          <ul v-if="readoutKinds.length" class="mt-2 space-y-1">
            <li v-for="k in readoutKinds" :key="k.kind" class="flex items-center gap-1.5 text-[11px]">
              <span class="size-1.5 shrink-0 rounded-full" :style="{ backgroundColor: k.color }" />
              <span class="text-muted-foreground">{{ t(k.labelKey) }}</span>
              <span class="ml-auto font-medium tabular-nums">{{ k.n }}</span>
            </li>
          </ul>
        </div>
      </div>
    </Transition>
  </div>
</template>
