import { describe, expect, it } from 'vitest'
import { createI18n } from 'vue-i18n'
import type { NotificationEntry } from '@knowledge/contracts'
import en from '@/i18n/messages/en.json'
import { notificationMessageKey } from './notification-ui'

/**
 * Every event phrase in the catalog is reachable through the key this module
 * builds. The phrases are flat dotted keys, so a key built with a bare dot
 * resolved none of them and every row printed its raw type.
 */
describe('notificationMessageKey', () => {
  const { t } = createI18n({ legacy: false, locale: 'en', missingWarn: false, messages: { en } }).global
  const entry = (type: string) => ({ type, reason: 'watching' }) as unknown as NotificationEntry

  it.each(Object.keys(en.notifications.event).filter((type) => type.includes('.')))('resolves %s', (type) => {
    const key = notificationMessageKey(entry(type))
    expect(t(key)).toBe(en.notifications.event[type as keyof typeof en.notifications.event])
  })
})
