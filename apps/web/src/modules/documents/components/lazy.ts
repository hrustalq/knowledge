import { defineAsyncComponent } from 'vue'

// The shell's search sheet: nobody pays for it until they open search.
export const SearchSheet = defineAsyncComponent(() => import('./SearchSheet.vue'))
