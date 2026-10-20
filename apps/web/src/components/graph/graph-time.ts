/**
 * The time axis of the graph (#81), as pure functions: the window the slider
 * spans, where a point sits on it, the density bars, keyboard steps and the
 * `asOf` a point turns into. Kept out of the slider so the arithmetic can be
 * read and tested without a DOM.
 */
import type { GraphTimelineDay, ReleaseTagDto } from '@knowledge/contracts'

export const DAY = 86_400_000
/** How far back the slider reaches when no tag asks for more. */
export const DEFAULT_WINDOW_DAYS = 90

/** A chosen point: an instant, and the tag it is when it is one. `null` is now. */
export interface TimePoint {
  at: number
  tag?: string
}

/** The window: the last 90 days, widened to start a day before the oldest tag. */
export function timelineWindow(tags: readonly Pick<ReleaseTagDto, 'at'>[], now: number): { from: number; to: number } {
  const oldest = Math.min(...tags.map((t) => Date.parse(t.at)), Infinity)
  return { from: Math.min(now - DEFAULT_WINDOW_DAYS * DAY, oldest - DAY), to: now }
}

export const fractionOf = (at: number, from: number, to: number) => Math.min(1, Math.max(0, (at - from) / (to - from)))
export const atFraction = (f: number, from: number, to: number) => from + Math.min(1, Math.max(0, f)) * (to - from)

/**
 * Fact changes folded into `buckets` bars, each 0..1 of the busiest. A change
 * is a change either way — a fact starting or stopping to be true — so the
 * bar is their sum. Days outside the window are ignored.
 */
export function densityBars(days: readonly GraphTimelineDay[], from: number, to: number, buckets: number): number[] {
  const bars = Array.from({ length: buckets }, () => 0)
  for (const d of days) {
    // A day counts from its start, clamped into the window: today's changes
    // happened before now even though today's noon has not come yet.
    const start = Date.parse(`${d.day}T00:00:00Z`)
    if (start >= to || start + DAY <= from) continue
    bars[Math.min(buckets - 1, Math.floor(fractionOf(Math.max(start, from), from, to) * buckets))]! += d.opened + d.closed
  }
  const max = Math.max(...bars, 0)
  return max === 0 ? bars : bars.map((b) => b / max)
}

/**
 * A keyboard step from `at`, or `null` for now. ←/→ move a day, PageUp/PageDown
 * a week, Home goes to the window's start and End to now. Stepping past the
 * end is now: the slider has no "later than today".
 */
export function stepPoint(at: number | null, key: string, from: number, to: number): number | null | undefined {
  const current = at ?? to
  const step = { ArrowLeft: -DAY, ArrowDown: -DAY, ArrowRight: DAY, ArrowUp: DAY, PageDown: -7 * DAY, PageUp: 7 * DAY }[key]
  if (key === 'Home') return from
  if (key === 'End') return null
  if (step === undefined) return undefined
  const next = Math.max(from, current + step)
  return next >= to ? null : next
}

/** The tag a drag ended on, when it is within `toleranceMs` of one: the thumb snaps to it. */
export function nearestTag<T extends Pick<ReleaseTagDto, 'at' | 'name'>>(at: number, tags: readonly T[], toleranceMs: number): T | null {
  let best: T | null = null
  let bestGap = toleranceMs
  for (const t of tags) {
    const gap = Math.abs(Date.parse(t.at) - at)
    if (gap <= bestGap) {
      best = t
      bestGap = gap
    }
  }
  return best
}

/** What the API is asked for: the tag by name when the point is one, else the instant. */
export const asOfParam = (point: TimePoint): string => (point.tag ? `tag:${point.tag}` : new Date(point.at).toISOString())
