import type { Locale } from '@knowledge/contracts'
import { getLocale } from './api'

/**
 * Locale-aware date, number and size formatting (docs/features/18).
 *
 * Every `toLocaleString`/`toLocaleDateString` call in this app used to pass no
 * locale at all, which means "follow the host" — the browser on the client and
 * the *server's* locale during SSR. Those two disagree the moment a user picks
 * a language, and disagreeing text in the same DOM node is a hydration
 * mismatch. So the locale is always explicit here, and always the app's.
 */

const BCP47: Record<Locale, string> = { en: 'en-GB', ru: 'ru-RU' }

function tag(locale?: Locale): string {
  return BCP47[locale ?? getLocale()]
}

/** Cached per tag+options: Intl constructors are expensive to build in a list. */
const dateCache = new Map<string, Intl.DateTimeFormat>()
function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`
  let hit = dateCache.get(key)
  if (!hit) {
    hit = new Intl.DateTimeFormat(locale, options)
    dateCache.set(key, hit)
  }
  return hit
}

/** Day precision — "9 Sept 2026" / "9 сент. 2026 г." */
export function formatDate(iso: string | Date, locale?: Locale): string {
  return dateFormat(tag(locale), { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso))
}

/** Day + time, for hover titles and audit rows. */
export function formatDateTime(iso: string | Date, locale?: Locale): string {
  return dateFormat(tag(locale), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

/** Day and month, dropping the year when it is the current one. */
export function formatDayMonth(iso: string | Date, locale?: Locale): string {
  const at = new Date(iso)
  const thisYear = at.getFullYear() === new Date().getFullYear()
  return dateFormat(tag(locale), {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: 'numeric' }),
  }).format(at)
}

export function formatNumber(value: number, locale?: Locale): string {
  return new Intl.NumberFormat(tag(locale)).format(value)
}

/**
 * Relative time, via Intl.RelativeTimeFormat so Russian gets its own plural
 * forms ("2 минуты назад" / "5 минут назад") without a hand-written table.
 */
export function formatRelative(iso: string | Date, locale?: Locale): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: 'auto' })
  const abs = Math.abs(seconds)
  if (abs < 60) return rtf.format(-seconds, 'second')
  if (abs < 3600) return rtf.format(-Math.round(seconds / 60), 'minute')
  if (abs < 86_400) return rtf.format(-Math.round(seconds / 3600), 'hour')
  if (abs < 2_592_000) return rtf.format(-Math.round(seconds / 86_400), 'day')
  // Past a month a relative phrase stops being informative — show the date.
  return formatDayMonth(iso, locale)
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
