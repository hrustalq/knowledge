import { defineAsyncComponent } from 'vue'

// For the page tree's row menu: one per row, so the dialog loads on first open.
export const LazyExportDialog = defineAsyncComponent(() => import('./ExportDialog.vue'))

// The C4 studio (#1244): full screen only, so its canvas, palette and editing code load on first open.
export const LazyC4Studio = defineAsyncComponent(() => import('./C4Studio.vue'))
// A C4 block on the public reader (#1244): the parser and both renderers load only on a page that has one.
export const LazyC4Diagram = defineAsyncComponent(() => import('./C4Diagram.vue'))
