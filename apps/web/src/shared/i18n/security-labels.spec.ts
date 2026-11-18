import { describe, expect, it } from 'vitest'
import { AUDIT_ACTIONS, AUTH_METHODS } from '@knowledge/contracts'
import en from '@/shared/i18n/messages/en.json'
import ru from '@/shared/i18n/messages/ru.json'
import uiEn from '@knowledge/ui/messages/en.json'
import uiRu from '@knowledge/ui/messages/ru.json'

// Every value the API can send has a label in both languages: a row reading
// `auth.session_revoked` in a Russian interface is a missed key, not a fallback.
describe('security labels', () => {
  type Catalogue = {
    security: { audit: { actions: Record<string, string> } }
  }
  const catalogues: Record<string, Catalogue> = { en, ru }
  // The session rows live in the kit (#1239), so their sign-in method labels are the kit's.
  const methods: Record<string, Record<string, string>> = { en: uiEn.ui.sessions.method, ru: uiRu.ui.sessions.method }
  it.each(Object.keys(catalogues))('%s labels every audit action and sign-in method', (lang) => {
    const c = catalogues[lang]
    expect(AUDIT_ACTIONS.filter((a) => !c.security.audit.actions[a.replaceAll('.', '_')])).toEqual([])
    expect(AUTH_METHODS.filter((m) => !methods[lang][m])).toEqual([])
  })
})
