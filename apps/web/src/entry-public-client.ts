import { createPublicApp } from './public-main'
import type { PublicReaderState } from './modules/reader'

declare global {
  interface Window {
    __KN_PUBLIC__?: PublicReaderState
  }
}

// The server rendered the page and left its state behind; hydrate onto it.
if (window.__KN_PUBLIC__) {
  performance.mark('knowledge:hydration-start')
  createPublicApp(window.__KN_PUBLIC__).app.mount('#app')
  performance.measure('knowledge:hydration', 'knowledge:hydration-start')
}
