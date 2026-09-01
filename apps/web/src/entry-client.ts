import type { StateTree } from 'pinia'
import { createApp } from './main'

declare global {
  interface Window {
    __PINIA__?: Record<string, StateTree>
  }
}

const { app, router, pinia } = createApp()

if (window.__PINIA__) {
  pinia.state.value = window.__PINIA__
}

router.isReady().then(() => {
  app.mount('#app')
})
