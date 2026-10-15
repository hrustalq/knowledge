import { createI18n, type I18n } from 'vue-i18n'
import { DEFAULT_LOCALE, type Locale } from '@knowledge/contracts'
import en from './messages/en.json'
import ru from './messages/ru.json'
import { russianPluralRule } from '@/lib/plural'

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
const russian: MessageSchema = ru

/**
 * One instance per app instance — created inside createApp(), never at module
 * scope: two concurrent SSR renders would otherwise share `locale` and one
 * request would render in the other's language.
 */
export function createI18nFor(locale: Locale): I18n {
  return createI18n({
    legacy: false,
    globalInjection: true,
    locale,
    fallbackLocale: DEFAULT_LOCALE,
    // A gap in ru falls back to English rather than warning in the console on
    // every render; the type check above is what actually prevents gaps.
    missingWarn: false,
    fallbackWarn: false,
    messages: { en, ru: russian },
    pluralRules: { ru: russianPluralRule },
  })
}
