import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [{ path: '/errors', component: () => import('./pages/ErrorsPage.vue') }]
