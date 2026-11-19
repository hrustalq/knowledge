import { defineAsyncComponent } from 'vue'

// A render_component reply (#1285): the graph canvas, search widget and activity
// feed load only when a turn actually carries a block, not with every chat.
export const LazyGenerativeUiBlock = defineAsyncComponent(() => import('./GenerativeUiBlock.vue'))
