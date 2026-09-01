import { createSSRApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import { createRouter } from './router'
import './style.css'

// Fresh app/router/pinia per request (SSR) or per page load (client).
export function createApp() {
  const app = createSSRApp(App)
  const pinia = createPinia()
  const router = createRouter()
  app.use(pinia)
  app.use(router)
  return { app, router, pinia }
}
