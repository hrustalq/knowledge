import { describe, expect, it } from 'vitest'
import { isOtherApp } from './own-path'

describe('isOtherApp', () => {
  it('claims the admin console and nothing that only starts like it', () => {
    for (const p of ['/admin', '/admin/', '/admin/users', '/admin?x=1']) expect(isOtherApp(p)).toBe(true)
    for (const p of ['/administration', '/documents', '/settings/access', '/']) expect(isOtherApp(p)).toBe(false)
  })
})
