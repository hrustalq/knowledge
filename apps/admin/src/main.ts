import { createApp, markRaw } from 'vue'
import { createPinia } from 'pinia'
import { VueQueryPlugin } from '@tanstack/vue-query'
import App from './app/App.vue'
import { createRouter, installAuthGuard } from './app/router'
import { createQueryClient } from './shared/api/queries'
import { createI18nFor } from './shared/i18n'
import './assets/style.css'

// The member app's composition (apps/web/src/main.ts), without SSR: one app
// per page load.
const app = createApp(App)
const pinia = createPinia()
const router = createRouter()
const i18n = createI18nFor()
const queryClient = createQueryClient()
// Stores read server data through the same cache components do: `this.queryClient` in an action.
pinia.use(() => ({ queryClient: markRaw(queryClient) }))
app.use(i18n).use(pinia).use(router).use(VueQueryPlugin, { queryClient })
installAuthGuard(router, pinia, i18n)
app.mount('#app')
