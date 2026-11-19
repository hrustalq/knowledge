// Auth store: resolves /v1/me once per page load and drives the router guard,
// like apps/web's stores/auth.ts. The session is the member app's HttpOnly
// cookie (#650); nothing here can read it, and there is no sign-in here — a
// signed-out visitor is sent to the member app's /login.
import { defineStore } from 'pinia'
import type { MeResponse } from '@knowledge/contracts'
import { fetchApi, isApiRequestError } from '@/shared/api/queries'
import { setApiLocale } from '@/shared/api/http'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    me: null as MeResponse | null,
    /** /v1/me answered (with a person or a 401). */
    loaded: false,
    /** /v1/me failed some other way: not a refusal, so the next navigation asks again. */
    error: null as unknown,
  }),
  getters: {
    /** AUTH_MODE=none — full access, as the API treats it. */
    isDev: (s) => s.me?.mode === 'dev',
    isAdmin: (s) => s.me?.isAdmin ?? false,
    /** The API's @PlatformAdmin() rule (auth/acl.guard.ts): a platform admin, or the dev principal. */
    canUseConsole(): boolean {
      return this.isAdmin || this.isDev
    },
  },
  actions: {
    async ensureLoaded() {
      if (this.loaded) return
      try {
        this.me = await fetchApi(this.queryClient, '/v1/me')
        setApiLocale(this.me.locale)
        this.loaded = true
        this.error = null
      } catch (e) {
        if (isApiRequestError(e) && e.status === 401) {
          this.me = null
          this.loaded = true
          this.error = null
        } else this.error = e
      }
    },
  },
})
