import { SSO_LOGIN_ERRORS, type SsoLoginError } from '@knowledge/contracts'
import { apiUrl } from '@/lib/api'

/**
 * SSO sign-in helpers (#75), kept out of the pages so they can be tested.
 *
 * The callback hands the browser a single-use code in the URL *fragment*
 * (`/auth/sso/complete#code=…`): a fragment is never sent to a server, so it
 * reaches neither the SSR process nor an access log nor a `Referer`. Only this
 * page's script reads it, and trades it for a session in a POST body.
 */
export function fragmentCode(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash)
  const code = params.get('code')
  return code && code.length <= 200 ? code : null
}

/** Where a "Continue with …" button sends the browser: the API's start route, which redirects to the IdP. */
export function ssoStartUrl(providerId: string, returnTo: string): string {
  return apiUrl(`/v1/auth/oidc/${encodeURIComponent(providerId)}/start?returnTo=${encodeURIComponent(returnTo)}`)
}

/** `?error=` on /login after a failed callback, if it is one the API sends. Anything else reads as none. */
export function ssoErrorOf(raw: unknown): SsoLoginError | null {
  return typeof raw === 'string' && (SSO_LOGIN_ERRORS as readonly string[]).includes(raw) ? (raw as SsoLoginError) : null
}

/** A return path from the query string, if it stays on this app. */
export function ownPath(raw: unknown, fallback = '/documents'): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : fallback
}

/** `?reauth=` on /login, set by a workspace's sign-in policy (#75 phase 4). Anything else reads as none. */
export function reauthKindOf(raw: unknown): 'sso' | 'session' | null {
  return raw === 'sso' || raw === 'session' ? raw : null
}
