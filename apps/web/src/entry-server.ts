import { AsyncLocalStorage } from 'node:async_hooks'
import { renderToString } from 'vue/server-renderer'
import { createApp } from './main'

interface SsrRequestContext {
  token: string | null
  workspaceId: string | null
  projectId: string | null
}

// Per-request auth context for lib/api (async-context scoped, so concurrent
// SSR renders can never observe each other's tokens). lib/api reads it via
// globalThis to stay free of node imports in the client bundle.
const ssrCtx = new AsyncLocalStorage<SsrRequestContext>()
;(globalThis as Record<string, unknown>).__KN_SSR_CTX__ = ssrCtx

export async function render(url: string, ctx: Partial<SsrRequestContext> = {}) {
  const request: SsrRequestContext = {
    token: ctx.token ?? null,
    workspaceId: ctx.workspaceId ?? null,
    projectId: ctx.projectId ?? null,
  }
  return ssrCtx.run(request, async () => {
    const { app, router, pinia } = createApp()

    await router.push(url)
    await router.isReady()

    const html = await renderToString(app)

    // Transfer Pinia state for hydration; escape < to prevent script breakout.
    const state = JSON.stringify(pinia.state.value).replace(/</g, '\\u003c')
    const head = `<script>window.__PINIA__ = ${state}</script>`

    return { html, head }
  })
}
