import { renderToString } from 'vue/server-renderer'
import { createApp } from './main'

export async function render(url: string) {
  const { app, router, pinia } = createApp()

  await router.push(url)
  await router.isReady()

  const html = await renderToString(app)

  // Transfer Pinia state for hydration; escape < to prevent script breakout.
  const state = JSON.stringify(pinia.state.value).replace(/</g, '\\u003c')
  const head = `<script>window.__PINIA__ = ${state}</script>`

  return { html, head }
}
