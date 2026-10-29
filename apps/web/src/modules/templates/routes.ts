import type { RouteRecordRaw } from 'vue-router'

export const settingsRoutes: RouteRecordRaw[] = [
  // Page templates (issue #69). One route for the roster, a template
  // (by ref, so an untouched built-in with no row id is linkable) and
  // `new`; the page reads the param, since all three share the rail.
  { path: 'templates/:ref?', component: () => import('./pages/TemplatesSettingsPage.vue') },
]
