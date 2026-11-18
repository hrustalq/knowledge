import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [{ path: '/users', component: () => import('./pages/UsersPage.vue') }]
