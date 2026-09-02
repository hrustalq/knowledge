/** Fallback workspace when the caller has no memberships (AUTH_MODE=none demo flow). */
export const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')

const TOKEN_KEY = 'kn_token'
const WS_KEY = 'kn_ws'

/** Typed API error so callers (and the router guard) can branch on 401/403. */
export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

// Client-side auth state lives in localStorage (+ mirrored into cookies so SSR
// can render authenticated pages). On the server the per-request values come
// from the AsyncLocalStorage context installed by entry-server — module state
// is never shared across concurrent SSR requests.
interface SsrRequestContext {
  token: string | null
  workspaceId: string | null
}
function ssrContext(): SsrRequestContext | undefined {
  return (
    globalThis as { __KN_SSR_CTX__?: { getStore(): SsrRequestContext | undefined } }
  ).__KN_SSR_CTX__?.getStore()
}

let clientToken: string | null = null
let clientWorkspaceId: string | null = null
if (!import.meta.env.SSR) {
  try {
    clientToken = localStorage.getItem(TOKEN_KEY)
    clientWorkspaceId = localStorage.getItem(WS_KEY)
  } catch {
    /* storage unavailable (private mode) — stay anonymous */
  }
}

export function getToken(): string | null {
  return import.meta.env.SSR ? (ssrContext()?.token ?? null) : clientToken
}

export function setToken(token: string | null): void {
  if (import.meta.env.SSR) return
  clientToken = token
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
      // Mirror into a cookie so the SSR pass renders as the logged-in user.
      // Set by JS on purpose (no httpOnly): the token is readable client-side
      // anyway via localStorage; SameSite=Lax limits cross-site sends.
      document.cookie = `${TOKEN_KEY}=${token}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`
    } else {
      localStorage.removeItem(TOKEN_KEY)
      document.cookie = `${TOKEN_KEY}=; path=/; max-age=0`
    }
  } catch {
    /* ignore */
  }
}

/** Active workspace for all API calls; falls back to the demo workspace. */
export function getWorkspaceId(): string {
  return (import.meta.env.SSR ? ssrContext()?.workspaceId : clientWorkspaceId) ?? DEMO_WORKSPACE_ID
}

export function setActiveWorkspace(workspaceId: string | null): void {
  if (import.meta.env.SSR) return
  clientWorkspaceId = workspaceId
  try {
    if (workspaceId) {
      localStorage.setItem(WS_KEY, workspaceId)
      document.cookie = `${WS_KEY}=${workspaceId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    } else {
      localStorage.removeItem(WS_KEY)
      document.cookie = `${WS_KEY}=; path=/; max-age=0`
    }
  } catch {
    /* ignore */
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken()
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${(await res.text()).slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

export function statusVariant(status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'indexed': return 'default'
    case 'failed': return 'destructive'
    case 'indexing': case 'finalized': return 'secondary'
    default: return 'outline'
  }
}

/** Tailwind classes for the small indexing-lifecycle dot shown next to page names. */
export function statusDot(status: string | null): string {
  switch (status) {
    case 'indexed': return 'bg-emerald-500'
    case 'failed': return 'bg-red-500'
    case 'indexing': case 'finalized': return 'bg-amber-500 animate-pulse'
    default: return 'bg-muted-foreground/40'
  }
}
