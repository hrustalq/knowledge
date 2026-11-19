/**
 * Locale-aware date, time, number and duration text (docs/features/18), shared
 * by both web apps (#1239). Here rather than in @knowledge/ui, whose lint keeps
 * Intl out of the kit: a kit component takes a formatter from its app, and the
 * app builds it from these. The locale is always explicit: a locale-less
 * `toLocale*` follows the host, which during SSR is the server, and the two
 * renders then disagree. Pass the app's language (`en`, `ru`); `bcp47` turns it
 * into the tag Intl reads.
 */

const BCP47: Record<string, string> = { en: 'en-GB', ru: 'ru-RU' };

/** `en` → `en-GB`; a tag that is already a full one passes through. */
export function bcp47(locale: string): string {
  return BCP47[locale] ?? locale;
}

/** Cached per tag+options: Intl constructors are expensive to build in a list. */
const dateCache = new Map<string, Intl.DateTimeFormat>();
export function dateFormat(locale: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(options)}`;
  let hit = dateCache.get(key);
  if (!hit) {
    hit = new Intl.DateTimeFormat(bcp47(locale), options);
    dateCache.set(key, hit);
  }
  return hit;
}

/** Day precision — "9 Sept 2026" / "9 сент. 2026 г." */
export function formatDate(iso: string | Date, locale: string): string {
  return dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

/** Day + time, for hover titles and audit rows. */
export function formatDateTime(iso: string | Date, locale: string): string {
  return dateFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** Clock time with seconds — "14:03:27". */
export function formatTime(iso: string | Date, locale: string): string {
  return dateFormat(locale, { timeStyle: 'medium' }).format(new Date(iso));
}

/** Day and month, dropping the year when it is the current one. */
export function formatDayMonth(iso: string | Date, locale: string): string {
  const at = new Date(iso);
  const thisYear = at.getFullYear() === new Date().getFullYear();
  return dateFormat(locale, { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) }).format(at);
}

export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(bcp47(locale)).format(value);
}

/**
 * Relative time, via Intl.RelativeTimeFormat so Russian gets its own plural
 * forms ("2 минуты назад" / "5 минут назад") without a hand-written table.
 * Past a month a relative phrase stops being informative: the date instead.
 */
export function formatRelative(iso: string | Date, locale: string): string {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  const rtf = new Intl.RelativeTimeFormat(bcp47(locale), { numeric: 'auto' });
  const abs = Math.abs(seconds);
  if (abs < 60) return rtf.format(-seconds, 'second');
  if (abs < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  if (abs < 2_592_000) return rtf.format(-Math.round(seconds / 86_400), 'day');
  return formatDayMonth(iso, locale);
}

/** A short duration — "320 ms", "45 sec", "3 min", "1.5 hr" / "3 мин" — by Intl unit formatting. */
export function formatDuration(ms: number, locale: string): string {
  const [value, unit] =
    ms < 1000
      ? [Math.round(ms), 'millisecond']
      : ms < 60_000
        ? [Math.round(ms / 1000), 'second']
        : ms < 3_600_000
          ? [Math.round(ms / 60_000), 'minute']
          : [ms / 3_600_000, 'hour'];
  return new Intl.NumberFormat(bcp47(locale), { style: 'unit', unit, unitDisplay: 'short', maximumFractionDigits: 1 }).format(value);
}
