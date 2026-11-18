import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  { path: '/users', component: () => import('./pages/UsersPage.vue') },
  { path: '/users/:id', component: () => import('./pages/UserPage.vue'), props: true },
]
