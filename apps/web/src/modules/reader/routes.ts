import type { Component } from 'vue'
import type { PublicReaderState } from './model/reader-state'

/**
 * The reader's three page roots, one lazy chunk each (#1281): a share link
 * loads only SharePage, never a published site's search, Ask or tree. The
 * reader has no router; the server resolved the view, and this is the one
 * place that maps it to a page, read by public-main.ts on both sides.
 */
export function readerPage(state: PublicReaderState): Promise<{ default: Component }> {
  switch (state.view.kind) {
    case 'site-widget':
      return import('./pages/SiteWidget.vue')
    case 'site':
    case 'site-not-found':
      return import('./pages/SitePage.vue')
    default:
      return import('./pages/SharePage.vue')
  }
}
