import { describe, expect, it, vi } from 'vitest'
import { SSO_LOGIN_ERRORS } from '@knowledge/contracts'
import en from '@/i18n/messages/en.json'
import ru from '@/i18n/messages/ru.json'
import { fragmentCode, ownPath, reauthKindOf, ssoErrorOf, ssoStartUrl } from './sso'

vi.mock('@/lib/api', () => ({ apiUrl: (p: string) => `/api${p}` }))

describe('SSO sign-in helpers (#75)', () => {
  it('reads ?reauth= as sso or session only — the router guard keeps a signed-in user on /login for it', () => {
    expect(reauthKindOf('sso')).toBe('sso')
    expect(reauthKindOf('session')).toBe('session')
    expect(reauthKindOf('1')).toBeNull()
    expect(reauthKindOf(['sso'])).toBeNull()
  })

  it('reads the exchange code from the fragment only', () => {
    expect(fragmentCode('#code=abc-123')).toBe('abc-123')
    expect(fragmentCode('code=abc')).toBe('abc')
    expect(fragmentCode('#token=ks_x')).toBeNull()
    expect(fragmentCode('')).toBeNull()
    expect(fragmentCode(`#code=${'x'.repeat(500)}`)).toBeNull()
  })

  it('starts at the API with the return path encoded', () => {
    expect(ssoStartUrl('p1', '/documents/a?b=1')).toBe('/api/v1/auth/oidc/p1/start?returnTo=%2Fdocuments%2Fa%3Fb%3D1')
    expect(ssoStartUrl('p1', '/documents', 'saml')).toBe('/api/v1/auth/saml/p1/start?returnTo=%2Fdocuments')
  })

  it('accepts only the callback errors the API sends', () => {
    expect(ssoErrorOf('jit-disabled')).toBe('jit-disabled')
    expect(ssoErrorOf('<script>')).toBeNull()
    expect(ssoErrorOf(['jit-disabled'])).toBeNull()
  })

  it('keeps a return path on this app', () => {
    expect(ownPath('/projects/x')).toBe('/projects/x')
    for (const bad of ['https://evil.example', '//evil.example', '/\\evil.example', undefined]) expect(ownPath(bad)).toBe('/documents')
  })

  it('every callback error has a message in both languages', () => {
    for (const c of [en, ru] as unknown as Array<{ auth: { sso: { errors: Record<string, string> } } }>) {
      expect(SSO_LOGIN_ERRORS.filter((e) => !c.auth.sso.errors[e])).toEqual([])
    }
  })
})
