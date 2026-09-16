import {
  DEFAULT_LOCALE,
  isApiErrorPayload,
  isLocale,
  type ApiErrorCode,
  type Locale,
} from '@knowledge/contracts'
import { formatRelative } from './format'

/** Fallback workspace when the caller has no memberships (AUTH_MODE=none demo flow). */
export const DEMO_WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'

const base = import.meta.env.SSR
  ? (process.env.API_URL_INTERNAL ?? 'http://localhost:3000')
  : (import.meta.env.VITE_API_URL ?? '/api')

const TOKEN_KEY = 'kn_token'
const WS_KEY = 'kn_ws'
const PROJECT_KEY = 'kn_proj'
const PANE_KEY = 'kn_pane'
const RAIL_KEY = 'kn_rail'
const RAIL_OPEN_KEY = 'kn_railopen'
/** The merge-request page's filter rail — its own state, not the app rail's. */
const FILTER_RAIL_KEY = 'kn_filterrail'
/** Whether glossary terms are linked in page content (docs/features/14). */
const GLOSSARY_KEY = 'kn_glossary'
/** Which branches of the sidebar page tree are open. */
const TREE_OPEN_KEY = 'kn_tree'
/**
 * How many open branches are remembered. This one rides on every request, and
 * a page tree with forty branches open is not a tree anyone is reading — the
 * oldest are dropped rather than letting the cookie grow without a bound.
 */
const TREE_OPEN_MAX = 40
const LANG_KEY = 'kn_lang'

/** Which level of the sidebar's navigation stack is showing (see stores/sidebar-nav). */
export type SidebarPane = 'projects' | 'pages'

/** Typed API error so callers (and the router guard) can branch on 401/403. */
export class ApiError extends Error {
  readonly status: number

  /**
   * The envelope's stable code, when the body was an ApiErrorPayload.
   *
   * Without it callers branched on message *text* — `msg.startsWith('409')` in
   * the editor — which breaks the moment the message is translated, and left a
   * 413 indistinguishable from any other failure.
   */
  readonly code?: ApiErrorCode

  constructor(status: number, message: string, code?: ApiErrorCode) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

// Client-side auth state lives in localStorage (+ mirrored into cookies so SSR
// can render authenticated pages). On the server the per-request values come
// from the AsyncLocalStorage context installed by entry-server — module state
// is never shared across concurrent SSR requests.
interface SsrRequestContext {
  token: string | null
  workspaceId: string | null
  projectId: string | null
  pane: string | null
  rail: string | null
  railOpen: string | null
  filterRail: string | null
  glossary: string | null
  treeOpen: string | null
  locale: Locale | null
  traceId: string | null
}
function ssrContext(): SsrRequestContext | undefined {
  return (
    globalThis as { __KN_SSR_CTX__?: { getStore(): SsrRequestContext | undefined } }
  ).__KN_SSR_CTX__?.getStore()
}

/**
 * The id to send as `x-request-id` on an outgoing API call.
 *
 * During SSR this is the page request's own trace id, so the browser's request,
 * the SSR render and every API call that render makes all share one id — which
 * is the whole reason the logger lives in a shared package rather than inside
 * apps/api. In the browser there is no enclosing request to inherit from, so
 * each call gets a fresh id; the API echoes it back on the response and carries
 * it in every error envelope.
 */
export function requestTraceId(): string {
  const inherited = import.meta.env.SSR ? ssrContext()?.traceId : null
  if (inherited) return inherited
  try {
    return crypto.randomUUID()
  } catch {
    // randomUUID needs a secure context; an id that is merely unique enough
    // beats no correlation at all.
    return `kn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

let clientToken: string | null = null
let clientWorkspaceId: string | null = null
let clientProjectId: string | null = null
let clientPane: string | null = null
let clientRail: string | null = null
let clientRailOpen: string | null = null
let clientFilterRail: string | null = null
let clientGlossary: string | null = null
let clientTreeOpen: string | null = null
let clientLocale: Locale | null = null
if (!import.meta.env.SSR) {
  try {
    clientToken = localStorage.getItem(TOKEN_KEY)
    clientWorkspaceId = localStorage.getItem(WS_KEY)
    clientProjectId = localStorage.getItem(PROJECT_KEY)
    clientPane = localStorage.getItem(PANE_KEY)
    clientRail = localStorage.getItem(RAIL_KEY)
    clientRailOpen = localStorage.getItem(RAIL_OPEN_KEY)
    clientFilterRail = localStorage.getItem(FILTER_RAIL_KEY)
    clientGlossary = localStorage.getItem(GLOSSARY_KEY)
    clientTreeOpen = localStorage.getItem(TREE_OPEN_KEY)
    const storedLocale = localStorage.getItem(LANG_KEY)
    if (isLocale(storedLocale)) clientLocale = storedLocale
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
  // Projects belong to a workspace, so the remembered one no longer applies —
  // and with no project to be inside, the rail belongs back at its top level.
  setActiveProject(null)
  setSidebarPane('projects')
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

/**
 * Active project (Workspace > Project > Document). Unlike getWorkspaceId there
 * is no fallback constant — project ids are created by the backfill migration,
 * so until the projects store resolves one this returns null and the API is
 * called without a projectId, which means "the whole workspace".
 */
export function getProjectId(): string | null {
  return (import.meta.env.SSR ? ssrContext()?.projectId : clientProjectId) ?? null
}

export function setActiveProject(projectId: string | null): void {
  if (import.meta.env.SSR) return
  clientProjectId = projectId
  try {
    if (projectId) {
      localStorage.setItem(PROJECT_KEY, projectId)
      document.cookie = `${PROJECT_KEY}=${projectId}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
    } else {
      localStorage.removeItem(PROJECT_KEY)
      document.cookie = `${PROJECT_KEY}=; path=/; max-age=0`
    }
  } catch {
    /* ignore */
  }
}

/**
 * Sidebar navigation stack level. Persisted exactly like the active project —
 * localStorage for the client plus a cookie so the SSR pass renders the same
 * pane the client is about to hydrate, instead of flashing the other one.
 */
export function getSidebarPane(): SidebarPane {
  const raw = import.meta.env.SSR ? ssrContext()?.pane : clientPane
  return raw === 'pages' ? 'pages' : 'projects'
}

export function setSidebarPane(pane: SidebarPane): void {
  if (import.meta.env.SSR) return
  clientPane = pane
  try {
    localStorage.setItem(PANE_KEY, pane)
    document.cookie = `${PANE_KEY}=${pane}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
}

/**
 * Rail geometry — how wide the navigation rail is, and whether it is open.
 *
 * Persisted the same way as the pane level, and for a sharper reason: these two
 * are the only stored facts the *first painted frame* depends on. Read them
 * client-side only and a rail someone widened to 22rem renders at 16rem and then
 * jumps, while a rail they collapsed renders open and then animates shut on
 * every single page load — the transition turning a one-frame flash into a
 * visible, repeated mistake. The cookie is what lets the server draw it right.
 *
 * Width is stored raw and clamped on read by the store that owns the bounds; a
 * cookie is user-editable, and a rail is not the place to trust one.
 */
export function getRailWidth(): number | null {
  const raw = import.meta.env.SSR ? ssrContext()?.rail : clientRail
  const px = Number(raw)
  return raw !== null && raw !== undefined && raw !== '' && Number.isFinite(px) ? px : null
}

export function setRailWidth(px: number): void {
  if (import.meta.env.SSR) return
  const value = String(Math.round(px))
  clientRail = value
  try {
    localStorage.setItem(RAIL_KEY, value)
    document.cookie = `${RAIL_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
}

export function getRailOpen(): boolean {
  const raw = import.meta.env.SSR ? ssrContext()?.railOpen : clientRailOpen
  // Unset means open: the rail is the default reading of this app, and a first
  // visit should not inherit "collapsed" from a missing cookie.
  return raw !== '0'
}

/**
 * The merge-request filter rail. Read on the server for the same reason as the
 * app rail: a rail the reader left open must not pop in after the first frame.
 *
 * Unset means closed, the opposite of the app rail: that one is how you get
 * anywhere, while this is a tool you reach for. The list is the page.
 */
/**
 * Glossary linking, as this reader wants it.
 *
 * **Unset means on** — the `kn_rail` polarity, not `kn_filterrail`'s: linking
 * is what the feature does, so someone who has never chosen should see it. It
 * earns a cookie rather than localStorage because it decides the first painted
 * frame; read after hydration, every definition link on the page would pop in.
 */
export function getGlossaryLinks(): boolean {
  const raw = import.meta.env.SSR ? ssrContext()?.glossary : clientGlossary
  return raw !== '0'
}

export function setGlossaryLinks(on: boolean): void {
  if (import.meta.env.SSR) return
  const value = on ? '1' : '0'
  clientGlossary = value
  try {
    localStorage.setItem(GLOSSARY_KEY, value)
    document.cookie = `${GLOSSARY_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
}

/**
 * Which branches of the page tree are open, oldest first — or null when nobody
 * has ever opened or closed one, which is what lets a first visit fall back to
 * "the top level, expanded" instead of to a tree with every branch shut.
 *
 * A cookie for the rail's reason: the tree is drawn server-side wherever the
 * page has the tree already, so reading this after hydration would open the
 * remembered branches a frame late, one row jumping down the rail per branch.
 *
 * Ids are joined with `.` — a comma is not legal unencoded in a cookie value,
 * and a UUID already spends `-`.
 */
export function getOpenTreeNodes(): string[] | null {
  const raw = import.meta.env.SSR ? ssrContext()?.treeOpen : clientTreeOpen
  if (raw === null || raw === undefined) return null
  return raw.split('.').filter(Boolean)
}

/** Persists what it kept, so the caller's copy and the cookie cannot diverge. */
export function persistOpenTreeNodes(ids: string[]): string[] {
  const kept = ids.slice(-TREE_OPEN_MAX)
  if (import.meta.env.SSR) return kept
  const value = kept.join('.')
  clientTreeOpen = value
  try {
    localStorage.setItem(TREE_OPEN_KEY, value)
    document.cookie = `${TREE_OPEN_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
  return kept
}

export function getFilterRailOpen(): boolean {
  const raw = import.meta.env.SSR ? ssrContext()?.filterRail : clientFilterRail
  return raw === '1'
}

export function setFilterRailOpen(open: boolean): void {
  if (import.meta.env.SSR) return
  const value = open ? '1' : '0'
  clientFilterRail = value
  try {
    localStorage.setItem(FILTER_RAIL_KEY, value)
    document.cookie = `${FILTER_RAIL_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
}

export function setRailOpen(open: boolean): void {
  if (import.meta.env.SSR) return
  const value = open ? '1' : '0'
  clientRailOpen = value
  try {
    localStorage.setItem(RAIL_OPEN_KEY, value)
    document.cookie = `${RAIL_OPEN_KEY}=${value}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
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
      // The API answers in this language (docs/features/18) — errors included,
      // and those surface straight into toasts.
      'Accept-Language': getLocale(),
      'x-request-id': requestTraceId(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    // The API normalises every failure into ApiErrorPayload, so prefer its
    // translated message and stable code. Throwing the raw body is what put
    // `500 Internal Server Error: {"statusCode":500,…}` into a toast; the
    // fallback stays for anything that answers before the filter runs (a proxy,
    // a gateway) and therefore is not an envelope at all.
    const text = await res.text()
    let parsed: unknown = null
    try {
      parsed = JSON.parse(text)
    } catch {
      /* not JSON — fall through to the raw-text form below */
    }
    if (isApiErrorPayload(parsed)) throw new ApiError(res.status, parsed.message, parsed.code)
    throw new ApiError(res.status, `${res.status} ${res.statusText}: ${text.slice(0, 300)}`)
  }
  return res.json() as Promise<T>
}

/**
 * Turn a stored API path into a URL the browser can put in `src`/`data`.
 *
 * Attachment links are stored in the markdown as bare `/v1/...` paths — no
 * host, no token — so the same document renders correctly through the dev
 * proxy, in production, and in anything else that reads the markdown. The
 * environment prefix and the credential are added here, at render time.
 *
 * `<img>` and `<object>` cannot send an Authorization header, so the token
 * rides in the query string; the API's AuthGuard already accepts `?token=` for
 * exactly this reason (it is how SSE authenticates too), and the request is
 * same-origin through the proxy.
 */
export function resolveAssetUrl(path: string): string {
  if (!path.startsWith('/v1/')) return path
  const token = getToken()
  const url = `${base}${path}`
  if (!token) return url
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`
}

/**
 * Kept as the shared entry point its 11 call sites already import; the actual
 * formatting moved to lib/format so it follows the UI language rather than the
 * host's (docs/features/18).
 */
export function relativeTime(iso: string): string {
  return formatRelative(iso)
}

export function statusVariant(status: string | null): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'indexed': case 'open': return 'default'
    case 'failed': return 'destructive'
    case 'indexing': case 'finalized': case 'merged': return 'secondary'
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

/**
 * Active UI language (docs/features/18). Persisted exactly like the sidebar
 * pane — localStorage for the client plus a cookie, so the SSR pass renders in
 * the same language the client is about to hydrate rather than flashing English
 * and swapping. The durable copy lives in users.locale; this mirrors it.
 */
export function getLocale(): Locale {
  return (import.meta.env.SSR ? ssrContext()?.locale : clientLocale) ?? DEFAULT_LOCALE
}

export function setLocale(locale: Locale): void {
  if (import.meta.env.SSR) return
  clientLocale = locale
  try {
    localStorage.setItem(LANG_KEY, locale)
    document.cookie = `${LANG_KEY}=${locale}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`
  } catch {
    /* ignore */
  }
}
