import { defineAsyncComponent } from 'vue'

// Loaded on first open (the shell mounts it once): its preview pipeline is not
// what a first load needs.
export const TemplateGalleryDialog = defineAsyncComponent(() => import('./TemplateGalleryDialog.vue'))
