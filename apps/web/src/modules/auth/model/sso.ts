import { SSO_LOGIN_ERRORS, type IdpKind, type SsoLoginError } from '@knowledge/contracts'
import { isApiRequestError } from '@/shared/api/http'
import { apiUrl } from '@/shared/api/api'

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

/** Where a "Continue with …" button sends the browser: the API's start route for its protocol, which redirects to the IdP. */
export function ssoStartUrl(providerId: string, returnTo: string, kind: IdpKind = 'oidc'): string {
  const protocol = kind === 'saml' ? 'saml' : 'oidc'
  return apiUrl(`/v1/auth/${protocol}/${encodeURIComponent(providerId)}/start?returnTo=${encodeURIComponent(returnTo)}`)
}

/** `?error=` on /login after a failed callback, if it is one the API sends. Anything else reads as none. */
export function ssoErrorOf(raw: unknown): SsoLoginError | null {
  return typeof raw === 'string' && (SSO_LOGIN_ERRORS as readonly string[]).includes(raw) ? (raw as SsoLoginError) : null
}

/** A return path from the query string, if it stays on this app. */
export function ownPath(raw: unknown, fallback = '/documents'): string {
  return typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\') ? raw : fallback
}

export interface CompleteSsoSteps {
  /** `window.location.hash`, where the callback put the code. */
  hash: string
  /** `window.location.pathname` — the address the fragment is wiped down to. */
  pathname: string
  /** `history.replaceState` with the URL to show: the wipe also drops the code from history. */
  replaceUrl: (url: string) => void
  /** Trade the code for a session; answers the path the sign-in started from. */
  exchange: (code: string) => Promise<string>
  /** `router.replace`. */
  navigate: (path: string) => Promise<unknown>
}

/**
 * The /auth/sso/complete sequence, store-free so it can be tested without
 * mounting the page (#293). The code leaves the address bar **before** the
 * network call, so neither a slow exchange nor a failed one leaves it in
 * history. Success follows `returnTo` only while it stays on this app; a
 * refused code goes to `/login?error=` with the category the API named, like
 * every other SSO failure (#291). No code at all navigates nowhere — the page
 * shows its own card.
 */
export async function completeSso(steps: CompleteSsoSteps): Promise<'done' | 'failed' | 'no-code'> {
  const code = fragmentCode(steps.hash)
  steps.replaceUrl(steps.pathname)
  if (!code) return 'no-code'
  let returnTo: string
  try {
    returnTo = await steps.exchange(code)
  } catch (e) {
    const error = (isApiRequestError(e) ? ssoErrorOf(e.details?.loginError) : null) ?? 'failed'
    await steps.navigate(`/login?error=${error}`)
    return 'failed'
  }
  await steps.navigate(ownPath(returnTo))
  return 'done'
}

/** `?reauth=` on /login, set by a workspace's sign-in policy (#75 phase 4). Anything else reads as none. */
export function reauthKindOf(raw: unknown): 'sso' | 'session' | null {
  return raw === 'sso' || raw === 'session' ? raw : null
}
