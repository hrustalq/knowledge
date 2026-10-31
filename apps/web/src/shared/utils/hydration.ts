/**
 * Whether the app is in its first, hydrating render (#643): entry-client sets
 * it around `app.mount`, which hydrates synchronously. A component that drew
 * something on the server it would not draw on a client navigation (a static
 * stand-in for a client-only widget) checks this to draw the same thing once.
 */
export const hydration = { active: false }

/**
 * An inert document to parse untrusted HTML in: nothing in it loads or runs.
 * jsdom on the server (entry-server installs it before a render that needs
 * one), a detached document in the browser.
 */
let inert: Document | null = null
export function inertDocument(): Document | null {
  if (import.meta.env.SSR) return (globalThis as { __KN_SSR_DOCUMENT__?: Document }).__KN_SSR_DOCUMENT__ ?? null
  return (inert ??= document.implementation.createHTMLDocument(''))
}

/** After the browser is idle (first paint is long done by then), or after `timeout` ms at the latest. */
export function whenIdle(fn: () => void, timeout = 5000) {
  if ('requestIdleCallback' in window) window.requestIdleCallback(fn, { timeout })
  else setTimeout(fn, Math.min(timeout, 2000))
}
