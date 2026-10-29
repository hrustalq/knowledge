import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  { path: '/merge-requests', component: () => import('./pages/MergeRequestsPage.vue') },
  { path: '/merge-requests/:id', component: () => import('./pages/MergeRequestDetailPage.vue') },
]
