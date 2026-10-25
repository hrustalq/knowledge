// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reauthPath } from './reauth'

const WS = '11111111-1111-4111-8111-111111111111'

describe('re-auth on enforced SSO (#75 phase 4)', () => {
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

describe('redirectForReauth (#293)', () => {
  const assign = vi.fn()
  const sso = { reason: 'ssoRequired', workspaceId: WS }

  /** A fresh module per test: its once-per-page-load flag is module state. */
  async function at(path: string) {
    vi.resetModules()
    const { pathname, search } = new URL(path, 'https://kb.example')
    vi.stubGlobal('location', { pathname, search, assign })
    return (await import('./reauth')).redirectForReauth
  }

  beforeEach(() => assign.mockReset())
  afterEach(() => vi.unstubAllGlobals())

  it('navigates to /login with the workspace and the way back — once, however many 403s follow', async () => {
    const redirect = await at('/documents/d1?tab=x')
    redirect(403, sso)
    redirect(403, sso)
    redirect(403, { reason: 'reauthRequired', workspaceId: WS })
    expect(assign).toHaveBeenCalledExactlyOnceWith(`/login?reauth=sso&workspaceId=${WS}&redirect=%2Fdocuments%2Fd1%3Ftab%3Dx`)
  })

  it('does nothing on /login or an /auth/ page — the redirect would loop', async () => {
    for (const path of ['/login?reauth=sso', '/auth/sso/complete']) {
      const redirect = await at(path)
      redirect(403, sso)
    }
    expect(assign).not.toHaveBeenCalled()
  })

  it('does nothing for a 403 that is not a re-auth, and leaves the next one free to redirect', async () => {
    const redirect = await at('/documents')
    redirect(403, { reason: 'emailUnverified' })
    redirect(403, undefined)
    redirect(401, sso)
    expect(assign).not.toHaveBeenCalled()
    redirect(403, sso)
    expect(assign).toHaveBeenCalledOnce()
  })

  it('the API client hands a 403 ssoRequired to it, and still rejects for the caller', async () => {
    await at('/documents')
    const body = {
      statusCode: 403,
      message: 'Sign in with SSO',
      code: 'FORBIDDEN',
      path: '/v1/documents',
      timestamp: new Date().toISOString(),
      requestId: 'r1',
      details: sso,
    }
    const { AxiosError } = await import('axios')
    const { http, ApiRequestError } = await import('@/api/http')
    // An adapter in place of the network: the 403 goes through the client's
    // own response interceptor, which is the thing under test.
    http.defaults.adapter = async (config) => {
      throw new AxiosError('Forbidden', 'ERR_BAD_REQUEST', config, null, {
        status: 403,
        statusText: 'Forbidden',
        data: body,
        headers: {},
        config,
      })
    }
    await expect(http.get('/v1/documents')).rejects.toBeInstanceOf(ApiRequestError)
    expect(assign).toHaveBeenCalledExactlyOnceWith(`/login?reauth=sso&workspaceId=${WS}&redirect=%2Fdocuments`)
  })
})
