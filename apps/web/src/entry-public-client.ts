import { createPublicApp } from './public-main'
import type { PublicReaderState } from './modules/reader'

declare global {
  interface Window {
    __KN_PUBLIC__?: PublicReaderState
  }
}

// The server rendered the page and left its state behind; hydrate onto it.
// Its page chunk is fetched first (#1281); the measure is the mount alone, as before.
if (window.__KN_PUBLIC__) {
  void createPublicApp(window.__KN_PUBLIC__).then(({ app }) => {
    performance.mark('knowledge:hydration-start')
    app.mount('#app')
    performance.measure('knowledge:hydration', 'knowledge:hydration-start')
  })
}
