import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // API specs (#78) are written as text, not in the page editor.
  { path: '/create/spec', component: () => import('./pages/ApiSpecEditorPage.vue') },
  { path: '/documents/:id/spec', component: () => import('./pages/ApiSpecEditorPage.vue') },
  { path: '/create/fixture', component: () => import('./pages/TestFixtureEditorPage.vue') },
  { path: '/documents/:id/fixture', component: () => import('./pages/TestFixtureEditorPage.vue') },
  // The QA view (#483): operations by suite state, and the fixture library.
  { path: '/qa', component: () => import('./pages/QaPage.vue'), meta: { feature: 'qa' } },
]

export const settingsRoutes: RouteRecordRaw[] = [
  // API reference (#78): the try-it proxy mode. Open to every member to
  // read, since the console needs to know; the page gates the change on
  // auth.canAdminWorkspace and the API enforces admin.
  { path: 'api', component: () => import('./pages/ApiSettingsPage.vue') },
]
