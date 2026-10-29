import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Legacy top-level path → its settings home.
  { path: '/docs', redirect: '/settings/docs' },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Docs: the product manual, bundled with the build it describes.
  // Same shell-plus-roster shape as projects — the rail lives here, the
  // article in the child, so switching articles replaces one pane.
  // Open to everyone: documentation nobody may read documents nothing.
  {
    path: 'docs',
    component: () => import('./pages/DocsPage.vue'),
    children: [{ path: ':slug?', component: () => import('./pages/DocsArticlePage.vue') }],
  },
]
