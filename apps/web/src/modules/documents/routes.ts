import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // App (authenticated — guard redirects to /login when AUTH_MODE=api-key)
  // meta.fill: the pages landing leads with a graph canvas, which needs a
  // definite height to resolve; the tree and list views scroll inside it.
  { path: '/documents', component: () => import('./pages/DocumentsListPage.vue'), meta: { fill: true } },
  { path: '/documents/:id', component: () => import('./pages/DocumentDetailPage.vue') },
  // A source-backed page (#674): linked to a URL, not written here.
  { path: '/create/source', component: () => import('./pages/LinkSourcePage.vue'), meta: { feature: 'sources' } },
  // Its extraction recipe and the review of a drafted one (#674, phase 2).
  { path: '/documents/:id/source/recipe', component: () => import('./pages/SourceRecipePage.vue'), meta: { feature: 'sources' } },
  // The same workbench for a crawled tree's recipe, which every page without its own reads with (phase 3b).
  { path: '/settings/connectors/:id/recipe', component: () => import('./pages/SourceRecipePage.vue'), meta: { feature: 'sources' } },
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
