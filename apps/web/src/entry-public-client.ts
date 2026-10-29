import { createPublicApp } from './public-main'
import type { PublicReaderState } from './modules/publishing/reader/reader-state'

declare global {
  interface Window {
    __KN_PUBLIC__?: PublicReaderState
  }
}

// The server rendered the page and left its state behind; hydrate onto it.
if (window.__KN_PUBLIC__) createPublicApp(window.__KN_PUBLIC__).app.mount('#app')
