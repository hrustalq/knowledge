import type { Crumb } from './breadcrumbs'

export const APP_NAME = 'Knowledge'

/**
 * The tab title (#644), read off the breadcrumb trail so the two cannot
 * disagree: the leaf, then the trail's root, then the app. A page the reader
 * may not open is never named in the trail, so it is never named here either.
 * An act on a crumb (Edit) keeps the thing it acts on beside it.
 */
export function titleFor(crumbs: Crumb[]): string {
  const leaf = crumbs.slice(crumbs.at(-1)?.action ? -2 : -1).reverse()
  return [...new Set([...leaf, ...crumbs.slice(0, 1)])].map((c) => c.label).concat(APP_NAME).join(' · ')
}
