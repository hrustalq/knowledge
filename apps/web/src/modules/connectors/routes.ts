import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Where every GitHub / Figma OAuth or App round trip ends (#564). Public:
  // it shows only the outcome in its own query, and must render in a tab
  // that is about to close itself.
  { path: '/oauth/:provider', component: () => import('./pages/OauthLandingPage.vue'), meta: { public: true, authCard: true } },
  // Where a chat bot's link-your-account link lands (issue #71). Needs the
  // app's session for the same reason: linking proves which person you are.
  { path: '/chat/link', component: () => import('./pages/ChatLinkPage.vue') },
  // One connector sync run (docs/features/26). Top-level rather than a child
  // of the settings shell for the reason the workflow wizard is: reviewing a
  // staged tree needs the whole viewport, and a settings nav beside it would
  // be a column of links nobody is going to follow mid-review. `meta.fill`
  // because the frame is fixed and the two panes scroll inside it.
  {
    path: '/settings/connectors/runs/:runId',
    component: () => import('./pages/ConnectorRunPage.vue'),
    meta: { fill: true },
  },
  // One connector, as something you read and operate (docs/features/32) — the
  // counterpart to the card on /settings/connectors, which is the form you
  // configure it in. Top-level rather than a settings child for the reason
  // the run page is: the work-items table wants the width, and the settings
  // nav beside it would be a column of links nobody follows from here.
  //
  // Declared AFTER `runs/:runId` deliberately. vue-router already scores the
  // literal higher, so this is habit rather than necessity — but the habit is
  // what keeps the next literal segment from being claimed by `:id`.
  { path: '/settings/connectors/:id', component: () => import('./pages/ConnectorDetailPage.vue') },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Connectors (docs/features/19): workspace administration, so like AI
  // settings it gates on auth.canAdminWorkspace rather than meta.platformAdmin.
  { path: 'connectors', component: () => import('./pages/ConnectorsPage.vue') },
  // Chat bots (issue #71): workspace administration, gated like connectors.
  { path: 'chat', component: () => import('./pages/ChatSettingsPage.vue') },
]
