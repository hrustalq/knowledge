import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Creating a workflow (docs/features/17).
  //
  // The wizard stays at the top level, full-viewport and trail-less: it is
  // a three-step conversation that ends by handing you the builder, not a
  // settings form you land on and leave. The builder itself is a child of
  // `/settings/workflows` — see there. A static segment outranks a param in
  // vue-router's scoring, so `new` beats the sibling `:id?` regardless of
  // declaration order.
  {
    path: '/settings/workflows/new',
    component: () => import('./pages/WorkflowWizardPage.vue'),
    meta: { fill: true, bare: true },
  },

  // Workflows (docs/features/17): the run list, and one run's node tree.
  { path: '/workflows', component: () => import('./pages/WorkflowsPage.vue') },
  { path: '/workflows/:id', component: () => import('./pages/WorkflowRunPage.vue') },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Workflows: like AI settings, deliberately not meta.platformAdmin —
  // this is workspace administration, so the page gates on
  // auth.canAdminWorkspace and the API enforces the admin role.
  // Deliberately not meta.fill: that drops <main>'s padding, which the
  // settings shell's negative-margin bleed depends on. The builder
  // bounds its own panes instead.
  {
    path: 'workflows',
    component: () => import('./pages/WorkflowSettingsPage.vue'),
    // Third rail, exactly as projects: the roster lives in the shell,
    // the selection here. The builder gave up the viewport to get the
    // app trail and the roster back — a chain you navigate to like
    // anything else, rather than a place you enter.
    //
    // Reading and editing are two routes, not one page with a toggle.
    // The canvas is a working surface: it holds a dirty draft and arms
    // an unsaved-changes guard on the way out, so opening it to glance
    // at a chain armed a confirm dialog for nothing. `/edit` is more
    // segments than `:id?`, so vue-router scores it first regardless of
    // declaration order — and Vue Flow only loads on that route.
    children: [
      { path: ':id/edit', component: () => import('./pages/WorkflowBuilderPage.vue') },
      { path: ':id?', component: () => import('./pages/WorkflowDetailPage.vue') },
    ],
  },
]
