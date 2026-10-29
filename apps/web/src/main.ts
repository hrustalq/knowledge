import { createSSRApp, markRaw } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './app/App.vue'
import { createRouter, installAuthGuard, installViewTransitions } from './app/router'
import { createQueryClient } from './shared/api/queries'
import { createI18nFor } from './shared/i18n'
import { getLocale } from './shared/api/api'
import { featureDirective } from './stores/features'
import './assets/style.css'

// Fresh app/router/pinia/query-client per request (SSR) or per page load (client).
export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()
  const router = createRouter()
  // Per app instance, never module scope: two concurrent SSR renders would
  // otherwise share `locale` (docs/features/18). Its catalog arrives async:
  // each entry awaits ensureLocaleMessages(i18n, …) before rendering/mounting.
  const i18n = createI18nFor(getLocale())
  const queryClient = createQueryClient()
  // Stores read server data through the same cache components do (#472):
  // `this.queryClient` in an action. Raw, or Pinia would make it reactive.
  pinia.use(() => ({ queryClient: markRaw(queryClient) }))
  app.use(i18n)
  app.use(pinia)
  app.use(router)
  app.use(VueQueryPlugin, { queryClient })
  // v-feature (#604): hides what the workspace switched off.
  app.directive('feature', featureDirective(pinia))
  installAuthGuard(router, pinia)
  installViewTransitions(router)
  return { app, router, pinia, i18n, queryClient }
}
