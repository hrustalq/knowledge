import type { ComposerTranslation } from 'vue-i18n'

/**
 * Label for a value that is *usually* one of a known set but is not constrained
 * to it (docs/features/18).
 *
 * `documents.category` is free text in the database — the eight
 * `DOCUMENT_CATEGORIES` are what the UI offers, not what the column allows, and
 * imported or API-created pages carry things like `onboarding`. Translating
 * blindly renders the key at the reader, so an unknown value falls back to
 * itself.
 */
export function labelFor(t: ComposerTranslation, prefix: string, value: string | null | undefined): string {
  if (!value) return ''
  const key = `${prefix}.${value}`
  const text = t(key)
  return text === key ? value : text
}
