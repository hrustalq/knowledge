import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // App (authenticated — guard redirects to /login when AUTH_MODE=api-key)
  // meta.fill: the pages landing leads with a graph canvas, which needs a
  // definite height to resolve; the tree and list views scroll inside it.
  { path: '/documents', component: () => import('./pages/DocumentsListPage.vue'), meta: { fill: true } },
  { path: '/documents/:id', component: () => import('./pages/DocumentDetailPage.vue') },
  { path: '/search', component: () => import('./pages/SearchPage.vue') },
  // Contradictions between pages (#81).
  { path: '/conflicts', component: () => import('./pages/ConflictsPage.vue'), meta: { feature: 'conflicts' } },
  // Legacy top-level paths → their settings home
  { path: '/glossary', redirect: '/settings/glossary' },
  { path: '/activity', redirect: '/settings/activity' },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Glossary: workspace vocabulary; the page gates writes on the
  // editor role, and reading it is open to any member.
  { path: 'glossary', component: () => import('./pages/GlossaryPage.vue') },
  { path: 'activity', component: () => import('./pages/ActivityPage.vue') },
]
