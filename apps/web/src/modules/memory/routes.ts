import type { RouteRecordRaw } from 'vue-router'

/**
 * Memory banks (#994), under /settings. The section has no `meta.feature`: an
 * admin who switched memory off comes back here to switch it on, and the page
 * says when the server has it off. A bank's page has one: with the section
 * off there is no bank to read.
 */
export const settingsRoutes: RouteRecordRaw[] = [
  { path: 'memory', component: () => import('./pages/MemorySettingsPage.vue') },
  { path: 'memory/:id', component: () => import('./pages/MemoryBankPage.vue'), meta: { feature: 'memory' } },
]
