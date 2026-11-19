import { defineAsyncComponent, defineComponent, h } from 'vue'
import { Skeleton } from '@knowledge/ui/skeleton'

// For the page view's graph tab: an ordinary page read never loads the force layout.
export const LazyGraphView = defineAsyncComponent(() => import('./GraphView.vue'))

// GraphCanvas's own loading state while its chunk arrives. inheritAttrs off: the
// async wrapper falls its props (nodes, edges…) through to whatever it renders.
const CanvasLoading = defineComponent({ inheritAttrs: false, render: () => h(Skeleton, { class: 'size-full rounded-none' }) })

// For the Pages graph view (#1279): tree and list never download the graph.
export const LazyGraphCanvas = defineAsyncComponent({ loader: () => import('./GraphCanvas.vue'), loadingComponent: CanvasLoading, delay: 0 })
