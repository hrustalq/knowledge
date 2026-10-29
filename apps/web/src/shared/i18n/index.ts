import { createI18n, type Composer, type I18n } from 'vue-i18n'
import type { Locale } from '@knowledge/contracts'
import type en from './messages/en.json'
import type ru from './messages/ru.json'
import { russianPluralRule } from '@/shared/i18n/plural'

/**
 * Message catalogs are JSON, matching apps/api (docs/features/18): one format
 * across the repo, and the files stay editable by translation tooling and by
 * people who do not read TypeScript.
 *
 * Type safety survives the format: `resolveJsonModule` gives the English
 * catalog an exact structural type, `MessageSchema` names it, and `ru.json` is
 * checked against it below — so a missing Russian key fails `vue-tsc` rather
 * than falling back silently in front of a user.
 */
export type MessageSchema = typeof en

// English is the key vocabulary; this is what makes a gap in ru a build error.
// Type-only: the assignment is never emitted, so it costs no bytes.
type AssertRussianComplete<T extends MessageSchema> = T
export type RussianSchema = AssertRussianComplete<typeof ru>

/**
 * Each catalog is its own chunk, loaded only for the language in use: the two
 * together were ~700 KB of the entry chunk, and a page only ever renders one.
 * The literal paths are what let the bundler split them, and the module map
 * caches each import() — shared safely by concurrent SSR renders, since a
 * catalog is immutable data, while a failed fetch is retried on the next call.
 * Per-request state (the `locale`) stays on the per-app instance below.
 */
const LOADERS: Record<Locale, () => Promise<{ default: MessageSchema }>> = {
  en: () => import('./messages/en.json'),
  ru: () => import('./messages/ru.json'),
}

/**
 * One instance per app instance — created inside createApp(), never at module
 * scope: two concurrent SSR renders would otherwise share `locale` and one
 * request would render in the other's language.
 *
 * It starts without messages; the entry awaits `ensureLocaleMessages` before
 * it renders (server) or mounts (client). No fallback catalog is loaded: the
 * type check above is what guarantees ru has every key en has.
 */
export function createI18nFor(locale: Locale): I18n {
  return createI18n({
    legacy: false,
    globalInjection: true,
    locale,
    missingWarn: false,
    // Not the default: without it vue-i18n seeds `{ [locale]: {} }`, which
    // `availableLocales` reports, so `ensureLocaleMessages` would never load.
    messages: {},
    pluralRules: { ru: russianPluralRule },
  })
}

/**
 * Make `locale`'s catalog available to an i18n instance. Call it, and await it,
 * before switching `locale.value` — switching first renders raw keys for as
 * long as the chunk takes to arrive.
 */
export async function ensureLocaleMessages(i18n: I18n | Composer, locale: Locale): Promise<void> {
  const composer = ('global' in i18n ? i18n.global : i18n) as Composer
  if (composer.availableLocales.includes(locale)) return
  composer.setLocaleMessage(locale, (await LOADERS[locale]()).default)
}
