import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // The inbox (docs/features/22). Top-level rather than under /settings:
  // it is a place you read, not a thing you configure — the preferences
  // that shape it live at /settings/notifications.
  { path: '/notifications', component: () => import('./pages/NotificationsPage.vue') },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // Also yours rather than the workspace's, though scoped to one
  // workspace: what you want to hear about here.
  { path: 'notifications', component: () => import('./pages/NotificationSettingsPage.vue') },
]
