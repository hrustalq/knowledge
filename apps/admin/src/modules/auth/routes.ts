import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // The guard's answer for anyone the console refuses, or when it could not ask.
  // `public`: the guard lets it through; `focus`: drawn without the shell.
  { path: '/403', component: () => import('./pages/GatePage.vue'), meta: { public: true, focus: true } },
]
