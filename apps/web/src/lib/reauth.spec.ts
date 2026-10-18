import { describe, expect, it } from 'vitest'
import { reauthPath } from './reauth'

describe('re-auth on enforced SSO (#75 phase 4)', () => {
  const WS = '11111111-1111-4111-8111-111111111111'

  it('sends ssoRequired and reauthRequired to /login with the workspace and the way back', () => {
    expect(reauthPath(403, { reason: 'ssoRequired', workspaceId: WS }, '/documents/d1?tab=x')).toBe(
      `/login?reauth=sso&workspaceId=${WS}&redirect=%2Fdocuments%2Fd1%3Ftab%3Dx`,
    )
    expect(reauthPath(403, { reason: 'reauthRequired', workspaceId: WS }, '/search')).toBe(
      `/login?reauth=session&workspaceId=${WS}&redirect=%2Fsearch`,
    )
  })

  it('leaves every other 403 — and a blocked API key — to the page', () => {
    expect(reauthPath(403, { reason: 'emailUnverified' }, '/x')).toBeNull()
    expect(reauthPath(403, { reason: 'apiKeysBlocked', workspaceId: WS }, '/x')).toBeNull()
    expect(reauthPath(403, undefined, '/x')).toBeNull()
    expect(reauthPath(401, { reason: 'ssoRequired' }, '/x')).toBeNull()
  })

  it('never makes /login the way back', () => {
    expect(reauthPath(403, { reason: 'ssoRequired', workspaceId: WS }, '/login?reauth=sso')).toBe(`/login?reauth=sso&workspaceId=${WS}`)
  })
})
