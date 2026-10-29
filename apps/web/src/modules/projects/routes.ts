import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // A project as something you read (docs/features/24) — the counterpart to
  // /settings/projects/:id, which is the form you edit it in. Declared
  // before the redirect below so the bare roster path still lands in
  // settings while an id opens the overview.
  { path: '/projects/:id', component: () => import('./pages/ProjectOverviewPage.vue') },
  // Legacy top-level path → its settings home.
  { path: '/projects', redirect: '/settings/projects' },
]

/** `/settings/projects`. app/router gives it its children, other modules' pages among them. */
export const settingsRoute = { path: 'projects', component: () => import('./pages/ProjectsPage.vue') } satisfies RouteRecordRaw

/** The selected project's form: the last child of `settingsRoute`. */
export const projectDetailRoute: RouteRecordRaw = { path: ':id?', component: () => import('./pages/ProjectDetailPage.vue') }
