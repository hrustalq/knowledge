import { describe, expect, it } from 'vitest'
import { readOauthLanding } from './oauth-landing'

describe('readOauthLanding (#564)', () => {
  it('reads a completed flow and keeps its signed return path', () => {
    expect(readOauthLanding('github', 'installed', '/projects/p1?tab=sources')).toEqual({
      provider: 'github',
      name: 'GitHub',
      outcome: 'installed',
      ok: true,
      back: '/projects/p1?tab=sources',
    })
  })

  it('reads anything unexpected as an error and never follows an off-site return path', () => {
    expect(readOauthLanding('figma', 'nonsense', '//evil.test/x')).toMatchObject({ outcome: 'error', ok: false, back: '/settings/connectors' })
    expect(readOauthLanding('figma', 'connected', '/\\evil.test')).toMatchObject({ ok: true, back: '/settings/connectors' })
    expect(readOauthLanding('gitlab', 'connected', '/x')).toMatchObject({ provider: null, outcome: 'error', ok: false })
    expect(readOauthLanding(undefined, undefined, undefined)).toMatchObject({ outcome: 'error', back: '/settings/connectors' })
  })
})
