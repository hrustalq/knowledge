/**
 * A workspace that enforces SSO (#75 phase 4) answers a password session, or
 * a session past its age cap, with 403 `reason: ssoRequired | reauthRequired`.
 * That is not "you may not" — it is "sign in again, this way", so the browser
 * goes to /login with the workspace whose providers to offer and the page to
 * come back to, instead of rendering an error state on every query.
 *
 * A leaf module: both HTTP stacks (shared/api/api.ts, shared/api/http.ts) call it.
 */

const REAUTH_REASONS = { ssoRequired: 'sso', reauthRequired: 'session' } as const

/** Where to send the browser for this error, or null when it is not a re-auth. */
export function reauthPath(status: number, details: Record<string, unknown> | undefined, current: string): string | null {
  if (status !== 403 || !details) return null
  const kind = REAUTH_REASONS[details.reason as keyof typeof REAUTH_REASONS]
  if (!kind) return null
  const query = new URLSearchParams({ reauth: kind })
  if (typeof details.workspaceId === 'string') query.set('workspaceId', details.workspaceId)
  if (current.startsWith('/') && !current.startsWith('/login')) query.set('redirect', current)
  return `/login?${query.toString()}`
}

let leaving = false

/** Browser only, once per page load, and never from /login itself — a burst of 403s is one navigation. */
export function redirectForReauth(status: number, details: Record<string, unknown> | undefined): void {
  if (leaving || typeof window === 'undefined') return
  const { pathname, search } = window.location
  if (pathname.startsWith('/login') || pathname.startsWith('/auth/')) return
  const target = reauthPath(status, details, pathname + search)
  if (!target) return
  leaving = true
  window.location.assign(target)
}
