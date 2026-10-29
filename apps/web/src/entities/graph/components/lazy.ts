import { defineAsyncComponent } from 'vue'

// For the page view's graph tab: an ordinary page read never loads the force layout.
export const LazyGraphView = defineAsyncComponent(() => import('./GraphView.vue'))
