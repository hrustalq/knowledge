import { AsyncLocalStorage } from 'node:async_hooks'
import { renderToString } from 'vue/server-renderer'
import type { Pinia } from 'pinia'
import type { Router } from 'vue-router'
import { DEFAULT_LOCALE, type Locale } from '@knowledge/contracts'
import { createApp } from './main'
import { ensureLocaleMessages } from './i18n'
import { useAuthStore } from './stores/auth'
import { useDocumentsStore } from './stores/documents'
import { useProjectsStore } from './stores/projects'

interface SsrRequestContext {
  token: string | null
  workspaceId: string | null
  projectId: string | null
  pane: string | null
  rail: string | null
  railOpen: string | null
  filterRail: string | null
  glossary: string | null
  aiPanel: string | null
  measure: string | null
  treeOpen: string | null
  locale: Locale | null
  /** The server's trace id for this page request, so API calls made during the render join it. */
  traceId: string | null
}

// Per-request auth context for lib/api (async-context scoped, so concurrent
// SSR renders can never observe each other's tokens). lib/api reads it via
// globalThis to stay free of node imports in the client bundle.
const ssrCtx = new AsyncLocalStorage<SsrRequestContext>()
;(globalThis as Record<string, unknown>).__KN_SSR_CTX__ = ssrCtx

/**
 * The rail is on every member route, and it reads the project roster and the
 * tree's first level. Loaded here, before anything draws, both are in the HTML
 * and in the state the client hydrates from, instead of arriving after
 * `main.js` has loaded, hydrated and asked (#279). Before the render rather than
 * in an `onServerPrefetch`: the rail renders ahead of the page, so state the
 * page fills in would reach the client but not the rail's HTML (#278).
 *
 * A failure leaves the store unloaded and the client fetches as it always did;
 * it never fails the render.
 */
async function prefetchShell(router: Router, pinia: Pinia, request: SsrRequestContext) {
  const auth = useAuthStore(pinia)
  // The same test App.vue makes between the signed-out card and the shell.
  if (router.currentRoute.value.meta.public || !auth.authenticated || auth.verificationPending) return

  const projects = useProjectsStore(pinia)
  const documents = useDocumentsStore(pinia)
  const scoped = request.projectId
  // The remembered project almost always still exists, so its tree is asked
  // for alongside the roster rather than after it.
  const early = scoped ? documents.fetchTree().catch(() => undefined) : null
  await projects.fetchList().catch(() => undefined)
  await early
  if (projects.loaded && projects.activeId !== scoped) {
    // The roster resolved another project (the cookie's is gone, or there was
    // none): render that one's tree, as the client would after its own fetch.
    // entry-client adopts the resolved id, so its API calls agree.
    request.projectId = projects.activeId
    documents.tree = []
    documents.treeLoaded = false
  }
  if (!documents.treeLoaded) await documents.fetchTree().catch(() => undefined)
  documents.treePrefetched = documents.treeLoaded
}

export async function render(url: string, ctx: Partial<SsrRequestContext> = {}) {
  const request: SsrRequestContext = {
    token: ctx.token ?? null,
    workspaceId: ctx.workspaceId ?? null,
    projectId: ctx.projectId ?? null,
    pane: ctx.pane ?? null,
    rail: ctx.rail ?? null,
    railOpen: ctx.railOpen ?? null,
    filterRail: ctx.filterRail ?? null,
    glossary: ctx.glossary ?? null,
    aiPanel: ctx.aiPanel ?? null,
    measure: ctx.measure ?? null,
    treeOpen: ctx.treeOpen ?? null,
    locale: ctx.locale ?? null,
    traceId: ctx.traceId ?? null,
  }
  return ssrCtx.run(request, async () => {
    const { app, router, pinia, i18n } = createApp()

    // The request's catalog only (cached after the first render that asks).
    const messagesReady = ensureLocaleMessages(i18n, request.locale ?? DEFAULT_LOCALE)
    await router.push(url)
    await router.isReady()
    await messagesReady
    await prefetchShell(router, pinia, request)

    const ssrContext: { teleports?: Record<string, string> } = {}
    let html = await renderToString(app, ssrContext)
    // The page action bar (#441) is a teleport into the shell's own markup, so
    // its buffer goes back into that element here; the client hydrates it there.
    for (const id of ['kn-page-actions', 'kn-page-toolbar']) {
      const buffer = ssrContext.teleports?.[`#${id}`]
      if (buffer) html = html.replace(new RegExp(`(<div id="${id}"[^>]*>)(</div>)`), (_, open, close) => open + buffer + close)
    }

    // Transfer Pinia state for hydration; escape < to prevent script breakout.
    const state = JSON.stringify(pinia.state.value).replace(/</g, '\\u003c')
    const head = `<script>window.__PINIA__ = ${state}</script>`

    return { html, head }
  })
}
