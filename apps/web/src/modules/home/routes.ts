import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // The workspace home (#1243). `/documents` stays the page browser.
  { path: '/', component: () => import('./pages/HomePage.vue') },
]
