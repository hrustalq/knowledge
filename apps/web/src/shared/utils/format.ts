import type { CostAmount, CostCurrency, Locale } from '@knowledge/contracts'
import * as shared from '@knowledge/contracts/format'
import { getLocale } from '../api/api'

/**
 * Locale-aware date, number and size formatting (docs/features/18).
 *
 * Every `toLocaleString`/`toLocaleDateString` call in this app used to pass no
 * locale at all, which means "follow the host" — the browser on the client and
 * the *server's* locale during SSR. Those two disagree the moment a user picks
 * a language, and disagreeing text in the same DOM node is a hydration
 * mismatch. So the locale is always explicit here, and always the app's.
 */

function tag(locale?: Locale): string {
  return shared.bcp47(locale ?? getLocale())
}
const dateFormat = shared.dateFormat

// The formatters both web apps need live in @knowledge/contracts/format (#1239); here they default to the app's locale.
export const formatDate = (iso: string | Date, locale?: Locale) => shared.formatDate(iso, locale ?? getLocale())
/** Day + time, for hover titles and audit rows. */
export const formatDateTime = (iso: string | Date, locale?: Locale) => shared.formatDateTime(iso, locale ?? getLocale())
/** Day and month, dropping the year when it is the current one. */
export const formatDayMonth = (iso: string | Date, locale?: Locale) => shared.formatDayMonth(iso, locale ?? getLocale())
export const formatNumber = (value: number, locale?: Locale) => shared.formatNumber(value, locale ?? getLocale())
/** Relative time ("2 минуты назад"), a date past a month. */
export const formatRelative = (iso: string | Date, locale?: Locale) => shared.formatRelative(iso, locale ?? getLocale())
/** A short duration — "320 ms", "45 sec", "3 min", "1.5 hr". */
export const formatDuration = (ms: number, locale?: Locale) => shared.formatDuration(ms, locale ?? getLocale())

/** A span of day + time; Intl collapses what both ends share ("21 Oct 2026, 08:29–08:32"). */
export function formatDateTimeRange(from: string | Date, to: string | Date, locale?: Locale): string {
  return dateFormat(tag(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatRange(new Date(from), new Date(to))
}

/** A 0–1 ratio as a percentage, at most one decimal: 0.1666 → "16.7%". */
/**
 * A USD price per million tokens. Keeps up to four decimals, because Jev's input
 * at 0.042 must not print as 0.04, and never fewer than two, so 2 reads as $2.00.
 */
export function formatPrice(amount: number, currency: CostCurrency = 'USD', locale?: Locale): string {
  return money(amount, currency, 4, locale)
}

function money(amount: number, currency: CostCurrency, maximumFractionDigits: number, locale?: Locale): string {
  return new Intl.NumberFormat(tag(locale), {
    style: 'currency',
    currency,
    // en-GB would otherwise print "US$2.00" beside every price.
    currencyDisplay: 'narrowSymbol',
    minimumFractionDigits: 2,
    maximumFractionDigits,
  }).format(amount)
}

/**
 * A stored cost. A real charge below a cent must not print as "$0.00": that
 * reads as "the assistant is free", which is the one thing this number exists
 * to disprove.
 */
export function formatCost({ micros, currency }: CostAmount, locale?: Locale): string {
  if (micros > 0 && micros < 10_000) return `<${money(0.01, currency, 2, locale)}`
  return money(micros / 1_000_000, currency, 2, locale)
}

/** One figure per currency, side by side: no rate is kept, so they are never one number. */
export function formatCosts(costs: readonly CostAmount[], locale?: Locale): string {
  return costs.length ? costs.map((c) => formatCost(c, locale)).join(' · ') : '—'
}

export function formatPercent(ratio: number, locale?: Locale): string {
  return new Intl.NumberFormat(tag(locale), { style: 'percent', maximumFractionDigits: 1 }).format(ratio)
}

/**
 * "PDF, Word or Markdown" / "PDF, Word или Markdown". `disjunction` for a
 * choice, `conjunction` for a set; duplicates are dropped.
 */
export function formatList(values: readonly string[], type: 'conjunction' | 'disjunction' = 'conjunction', locale?: Locale): string {
  return new Intl.ListFormat(tag(locale), { style: 'long', type }).format([...new Set(values)])
}

/**
 * Month or weekday name for a calendar day (`YYYY-MM-DD`), read in UTC so the
 * label never shifts a day across the reader's offset.
 */
export function formatCalendarPart(day: string, part: 'month' | 'weekday', locale?: Locale): string {
  return dateFormat(tag(locale), { [part]: 'short', timeZone: 'UTC' }).format(new Date(`${day}T00:00:00.000Z`))
}

const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/** Byte size with a locale-formatted number (the unit stays SI, untranslated). */
export function formatBytes(bytes: number, locale?: Locale): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${SIZE_UNITS[0]}`
  const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), SIZE_UNITS.length - 1)
  const value = bytes / 1024 ** exp
  const formatted = new Intl.NumberFormat(tag(locale), {
    maximumFractionDigits: exp === 0 ? 0 : value < 10 ? 1 : 0,
  }).format(value)
  return `${formatted} ${SIZE_UNITS[exp]}`
}

/** The CLDR plural category of `n` — `one`, `few`, `many`, `other` — for a catalog that lists its forms by name. */
export function pluralCategory(n: number, locale?: Locale): Intl.LDMLPluralRule {
  return new Intl.PluralRules(tag(locale)).select(n)
}

