import { createI18n, type I18n } from 'vue-i18n'
import { DEFAULT_LOCALE, type Locale } from '@knowledge/contracts'
import en from './messages/en.json'
import ru from './messages/ru.json'

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
 * Russian plural selection.
 *
 * vue-i18n's default rule is English (two forms). Russian needs four choices —
 * `нет страниц | 1 страница | 2 страницы | 5 страниц` — and 11–14 are "many"
 * despite ending in 1–4, which is exactly the case a naive `n === 1` gets wrong.
 */
function russianPluralRule(choice: number, choicesLength: number): number {
  if (choice === 0) return 0
  const teen = choice > 10 && choice < 20
  const endsWithOne = choice % 10 === 1
  if (!teen && endsWithOne) return 1
  if (!teen && choice % 10 >= 2 && choice % 10 <= 4) return 2
  return choicesLength < 4 ? 2 : 3
}

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
