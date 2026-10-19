import { describe, expect, it, vi } from 'vitest'
import { SSO_LOGIN_ERRORS } from '@knowledge/contracts'
import en from '@/i18n/messages/en.json'
import ru from '@/i18n/messages/ru.json'
import { ApiError } from '@/lib/api'
import { completeSso, fragmentCode, ownPath, reauthKindOf, ssoErrorOf, ssoStartUrl, type CompleteSsoSteps } from './sso'

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiUrl: (p: string) => `/api${p}`,
}))

describe('/auth/sso/complete (#293)', () => {
  /** The page's steps, recorded in the order they ran. */
  function steps(over: Partial<CompleteSsoSteps> & { returnTo?: string } = {}) {
    const order: string[] = []
    const s = {
      hash: '#code=abc-123',
      pathname: '/auth/sso/complete',
      replaceUrl: vi.fn((url: string) => void order.push(`replace ${url}`)),
      exchange: vi.fn(async (code: string) => {
        order.push(`exchange ${code}`)
        return over.returnTo ?? '/projects/x'
      }),
      navigate: vi.fn(async (path: string) => void order.push(`navigate ${path}`)),
      ...over,
    }
    return { s, order }
  }

  it('wipes the code from the address bar before the exchange, then goes where the sign-in started', async () => {
    const { s, order } = steps()
    expect(await completeSso(s)).toBe('done')
    expect(order).toEqual(['replace /auth/sso/complete', 'exchange abc-123', 'navigate /projects/x'])
  })

  it('never calls the exchange without a code, and still wipes the fragment', async () => {
    const { s, order } = steps({ hash: '#token=ks_x' })
    expect(await completeSso(s)).toBe('no-code')
    expect(s.exchange).not.toHaveBeenCalled()
    expect(s.navigate).not.toHaveBeenCalled()
    expect(order).toEqual(['replace /auth/sso/complete'])
  })

  it('does not follow a returnTo that leaves the app', async () => {
    for (const evil of ['https://evil.example', '//evil.example']) {
      const { s } = steps({ returnTo: evil })
      expect(await completeSso(s)).toBe('done')
      expect(s.navigate).toHaveBeenCalledExactlyOnceWith('/documents')
    }
  })

  it('a refused exchange goes to /login?error= with the category the API named (#291)', async () => {
    const refused = new ApiError(400, 'invalid', 'BAD_REQUEST', { loginError: 'exchange-invalid' })
    const { s, order } = steps({ exchange: vi.fn(async () => Promise.reject(refused)) })
    expect(await completeSso(s)).toBe('failed')
    expect(order).toEqual(['replace /auth/sso/complete', 'navigate /login?error=exchange-invalid'])
  })

  it('a failure without a known category — or not from the API at all — reads as failed', async () => {
    for (const e of [new ApiError(400, 'x', 'BAD_REQUEST', { loginError: '<script>' }), new TypeError('fetch failed')]) {
      const { s } = steps({ exchange: vi.fn(async () => Promise.reject(e)) })
      expect(await completeSso(s)).toBe('failed')
      expect(s.navigate).toHaveBeenCalledExactlyOnceWith('/login?error=failed')
    }
  })
})

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
