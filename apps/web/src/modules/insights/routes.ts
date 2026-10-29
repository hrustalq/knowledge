import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Knowledge health (docs/features/40): the workspace's pages by
  // verification state, bulk actions and the freshness policy.
  { path: '/knowledge-health', component: () => import('./pages/KnowledgeHealthPage.vue') },
  // Usage analytics (#79). Gated in the page on auth.canAdminWorkspace; the API enforces admin.
  { path: '/analytics', component: () => import('./pages/AnalyticsPage.vue') },
]
