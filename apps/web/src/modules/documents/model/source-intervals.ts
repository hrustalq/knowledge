import { SOURCE_INTERVALS_MIN } from '@knowledge/contracts'

type Interval = (typeof SOURCE_INTERVALS_MIN)[number]

/**
 * The check intervals a source offers (#674), as select values. A select
 * holds strings, so "only when asked" is `manual` rather than null.
 */
export const SOURCE_INTERVAL_OPTIONS = [
  ...SOURCE_INTERVALS_MIN.map((m) => ({ value: String(m), label: `sources.interval.m${m}` })),
  { value: 'manual', label: 'sources.interval.manual' },
] as const

export const intervalValue = (minutes: number | null): string => (minutes === null ? 'manual' : String(minutes))
export const toInterval = (value: string): Interval | null => (value === 'manual' ? null : (Number(value) as Interval))
