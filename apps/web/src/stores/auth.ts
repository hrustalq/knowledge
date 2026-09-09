// Auth store: resolves /v1/me once per app instance (per SSR request / per
// client load), owns the session token, and drives router guards + nav state.
import { defineStore } from 'pinia'
import type { AuthSessionResponse, Locale, MeResponse, WorkspaceRole } from '@knowledge/contracts'
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
      return this.role !== null
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
    async login(email: string, password: string) {
      const res = await apiFetch<AuthSessionResponse>('/v1/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      })
      this.adoptSession(res)
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
