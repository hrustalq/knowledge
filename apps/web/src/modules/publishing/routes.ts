import type { RouteRecordRaw } from 'vue-router'

export const settingsRoutes: RouteRecordRaw[] = [
  // Publishing (docs/features/43): the workspace's public-link switches
  // and the inventory of every link. Gated in the page on
  // auth.canAdminWorkspace, as AI settings are; the API enforces admin.
  { path: 'publishing', component: () => import('./pages/PublishingSettingsPage.vue') },
  { path: 'exports', component: () => import('./pages/ExportsPage.vue') },
  // Release tags (#81): open to every role to read, like the timeline they mark.
  { path: 'releases', component: () => import('./pages/ReleasesSettingsPage.vue') },
]

/** Children of /settings/projects: the project page's rail holds them. */
export const projectSiteRoutes: RouteRecordRaw[] = [
  // A project's published site (docs/features/44). The page gates
  // its controls on auth.canAdminWorkspace; the API enforces admin.
  { path: ':id/site', component: () => import('./pages/SiteSettingsPage.vue') },
]
