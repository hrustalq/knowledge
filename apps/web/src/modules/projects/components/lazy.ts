import { defineAsyncComponent } from 'vue'

// Loaded on first open, as the sidebar always has (#279).
export const SwitcherCreateDialog = defineAsyncComponent(() => import('./SwitcherCreateDialog.vue'))
