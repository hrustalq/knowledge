import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // A project as something you read (docs/features/24) — the counterpart to
  // /settings/projects/:id, which is the form you edit it in. Declared
  // before the redirect below so the bare roster path still lands in
  // settings while an id opens the overview.
  // Creating a project from a blueprint (#716): full-viewport and trail-less,
  // like the workflow wizard. A static segment outranks `:id` in vue-router.
  { path: '/projects/new', component: () => import('./pages/ScaffoldWizardPage.vue'), meta: { fill: true, bare: true } },
  { path: '/projects/:id', component: () => import('./pages/ProjectOverviewPage.vue') },
  // Legacy top-level path → its settings home.
  { path: '/projects', redirect: '/settings/projects' },
]

/** `/settings/projects`. app/router gives it its children, other modules' pages among them. */
export const settingsRoute = { path: 'projects', component: () => import('./pages/ProjectsPage.vue') } satisfies RouteRecordRaw

/** `/settings/blueprints` (#716): built-in and saved blueprints, by key (a built-in key or a saved id). */
export const blueprintsSettingsRoute = {
  path: 'blueprints/:key?',
  component: () => import('./pages/BlueprintsSettingsPage.vue'),
} satisfies RouteRecordRaw

/** `/settings/projects/:id/policies` (#928): every workspace setting the project may override. Before `projectDetailRoute`. */
export const projectPoliciesRoute: RouteRecordRaw = { path: ':id/policies', component: () => import('./pages/ProjectSettingsPage.vue') }

/** The selected project's form: the last child of `settingsRoute`. */
export const projectDetailRoute: RouteRecordRaw = { path: ':id?', component: () => import('./pages/ProjectDetailPage.vue') }
