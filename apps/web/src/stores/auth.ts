// Auth store: resolves /v1/me once per app instance (per SSR request / per
// client load), owns the session token, and drives router guards + nav state.
import { defineStore } from 'pinia'
import type {
  AuthMethod,
  AuthSessionResponse,
  Locale,
  MeResponse,
  SsoDiscoverResponse,
  SsoExchangeResponse,
  SsoProvidersResponse,
  WorkspaceRole,
} from '@knowledge/contracts'
import { ApiError, apiFetch, getWorkspaceId, setActiveWorkspace, setToken } from '@/lib/api'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeResponse | null,
    /** /v1/me has been attempted (success or 401). */
    loaded: false,
  }),
  getters: {
    authenticated: (s) => s.me !== null,
    /** AUTH_MODE=none — no login UI, full access. */
    isDev: (s) => s.me?.mode === 'dev',
    isAdmin: (s) => s.me?.isAdmin ?? false,
    /** How the current session was opened (#75); null for an API key or the dev principal. */
    authMethod: (s): AuthMethod | null => s.me?.authMethod ?? null,
    /**
     * AUTH_REQUIRE_VERIFIED_EMAIL is on and this address is unconfirmed: the API
     * refuses everything but /me, logout and resend, so the app is a single
     * card until the mailed link is followed (docs/features/41).
     */
    verificationPending: (s) => !!s.me && s.me.emailVerificationRequired && !s.me.emailVerified,
    /** Caller's role in the active workspace ('admin' for dev/platform admins). */
    role(): WorkspaceRole | null {
      if (!this.me) return null
      if (this.me.mode === 'dev' || this.me.isAdmin) return 'admin'
      return this.me.memberships.find((m) => m.workspaceId === getWorkspaceId())?.role ?? null
    },
    canEdit(): boolean {
      return this.role === 'editor' || this.role === 'admin'
    },
    /**
     * Commenting is a viewer action (feature 15): whoever may read a page may
     * annotate it. Mirrors `@Access('viewer', 'document')` on the API's
     * thread routes.
     */
    canComment(): boolean {
      // A guest reads only what is granted to it (#76), so workspace-wide it
      // can comment on nothing — the API refuses it every `viewer` route.
      return this.role !== null && this.role !== 'guest'
    },
    canAdminWorkspace(): boolean {
      return this.role === 'admin'
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      try {
        this.adopt(await apiFetch<MeResponse>('/v1/me'))
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 401)) console.error('auth: /v1/me failed', e)
        this.me = null
      }
      this.loaded = true
    },
    /** Re-resolve /v1/me after a change the principal carries (rename, key rotation). */
    async reload() {
      try {
        this.adopt(await apiFetch<MeResponse>('/v1/me'))
      } catch {
        /* the caller's own change already succeeded; a stale name is not worth an error */
      }
    },
    async login(email: string, password: string) {
      const res = await apiFetch<AuthSessionResponse>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      this.adoptSession(res)
    },
    /**
     * The login page's SSO buttons (#75), or null when SSO is off on this
     * instance — the routes answer 404 then, and the page is the plain
     * password form it always was.
     */
    async ssoProviders(workspaceId: string): Promise<SsoProvidersResponse | null> {
      try {
        return await apiFetch<SsoProvidersResponse>(`/v1/auth/sso/providers?workspaceId=${encodeURIComponent(workspaceId)}`)
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null
        throw e
      }
    },
    /** Email-first sign-in: which providers assert this address's domain. */
    discover(email: string): Promise<SsoDiscoverResponse> {
      return apiFetch<SsoDiscoverResponse>('/v1/auth/sso/discover', { method: 'POST', body: JSON.stringify({ email }) })
    },
    /** Trade the callback's fragment code for a session; answers where the sign-in started. */
    async exchangeSsoCode(code: string): Promise<string> {
      const res = await apiFetch<SsoExchangeResponse>('/v1/auth/sso/exchange', {
        method: 'POST',
        body: JSON.stringify({ code }),
      })
      this.adoptSession(res)
      return res.returnTo
    },
    async signup(email: string, displayName: string, password: string) {
      const res = await apiFetch<AuthSessionResponse>('/v1/auth/signup', {
        method: 'POST',
        body: JSON.stringify({ email, displayName, password }),
      })
      this.adoptSession(res)
    },
    async logout() {
      try {
        await apiFetch('/v1/auth/logout', { method: 'POST' })
      } catch {
        /* revoking a dead session is fine */
      }
      setToken(null)
      this.me = null
    },
    setWorkspace(workspaceId: string) {
      setActiveWorkspace(workspaceId)
    },
    adoptSession(res: AuthSessionResponse) {
      setToken(res.token)
      this.adopt(res.me)
      this.loaded = true
    },
    /** Keep the active workspace valid for the freshly resolved principal. */
    /**
     * Persist the language choice to users.locale (docs/features/18), so it
     * follows the user to another browser. Best-effort: the cookie already
     * carries the choice for this browser, and the dev principal has no users
     * row to write to — neither is worth failing the switch over.
     */
    async saveLocale(locale: Locale) {
      if (this.me) this.me = { ...this.me, locale }
      try {
        await apiFetch('/v1/me', { method: 'PATCH', body: JSON.stringify({ locale }) })
      } catch {
        /* cookie already holds it; the durable copy can wait for the next switch */
      }
    },

    adopt(me: MeResponse) {
      this.me = me
      const seesAll = me.mode === 'dev' || me.isAdmin
      const current = getWorkspaceId()
      if (!seesAll && !me.memberships.some((m) => m.workspaceId === current)) {
        setActiveWorkspace(me.memberships[0]?.workspaceId ?? null)
      }
    },
  },
})
