import { defineAsyncComponent } from 'vue'

// For the page tree's row menu: one per row, so the dialog loads on first open.
export const LazyExportDialog = defineAsyncComponent(() => import('./ExportDialog.vue'))
