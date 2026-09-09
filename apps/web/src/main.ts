import { createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './App.vue'
import { createRouter, installAuthGuard } from './router'
import { createQueryClient } from './api/queries'
import { createI18nFor } from './i18n'
import { getLocale } from './lib/api'
import './style.css'

// Fresh app/router/pinia/query-client per request (SSR) or per page load (client).
export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()
  const router = createRouter()
  // Per app instance, never module scope: two concurrent SSR renders would
  // otherwise share `locale` (docs/features/18).
  app.use(createI18nFor(getLocale()))
  app.use(pinia)
  app.use(router)
  app.use(VueQueryPlugin, { queryClient: createQueryClient() })
  installAuthGuard(router, pinia)
  return { app, router, pinia }
}
