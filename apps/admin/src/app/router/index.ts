import { createRouter as createVueRouter, createWebHistory, type Router } from 'vue-router'
import type { Pinia } from 'pinia'
import type { createI18nFor } from '@/shared/i18n'
import { useAuthStore } from '@/stores/auth'
import * as auth from '@/modules/auth/routes'
import * as config from '@/modules/config/routes'
import * as monitoring from '@/modules/monitoring/routes'
import * as users from '@/modules/users/routes'
import * as errors from '@/modules/errors/routes'

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable whatever the gate says: the gate's own page. */
    public?: boolean
    /** Drawn without the shell. */
    focus?: boolean
  }
}

export function createRouter(): Router {
  return createVueRouter({
    history: createWebHistory('/admin/'),
    routes: [
      { path: '/', redirect: '/config' },
      ...auth.routes,
      ...config.routes,
      ...monitoring.routes,
      ...users.routes,
      ...errors.routes,
      { path: '/:rest(.*)*', redirect: '/config' },
    ],
  })
}

/** The member app's sign-in, coming back to `href` (a full /admin/… path). */
export function signInUrl(href: string): string {
  return `/login?${new URLSearchParams({ redirect: href })}`
}

/**
 * Nothing renders, and no admin route is called, until /v1/me says who this
 * is (#1236):
 * - signed out → the member app's /login, which brings them back
 * - anyone but a platform admin (or the dev principal) → /403
 * - /v1/me failed → /403, which shows the failure and a retry
 * The API's @PlatformAdmin() guard is the real door; this only keeps a
 * non-admin from seeing an empty console.
 */
export function installAuthGuard(router: Router, pinia: Pinia, i18n: ReturnType<typeof createI18nFor>) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore(pinia)
    await auth.ensureLoaded()
    if (auth.me) {
      i18n.global.locale.value = auth.me.locale
      document.documentElement.lang = auth.me.locale
    } else if (auth.loaded) {
      window.location.assign(signInUrl(router.resolve(to).href))
      return false
    }
    if (to.meta.public) return true
    return auth.canUseConsole ? true : { path: '/403', replace: true }
  })
}
