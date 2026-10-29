import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // What coding agents proposed from their sessions (issue #73).
  { path: '/captures', component: () => import('./pages/CapturesPage.vue'), meta: { feature: 'captures' } },
]
