import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [{ path: '/monitoring', component: () => import('./pages/MonitoringPage.vue') }]
