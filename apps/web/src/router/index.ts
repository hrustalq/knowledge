import { createMemoryHistory, createRouter as createVueRouter, createWebHistory, type Router } from 'vue-router'
import type { Pinia } from 'pinia'
import { useAuthStore } from '@/stores/auth'

export function createRouter() {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    routes: [
      { path: '/', redirect: '/documents' },
      // Auth flow (public)
      { path: '/login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true } },
      { path: '/signup', component: () => import('@/pages/SignupPage.vue'), meta: { public: true } },
      { path: '/forgot-password', component: () => import('@/pages/ForgotPasswordPage.vue'), meta: { public: true } },
      { path: '/reset-password', component: () => import('@/pages/ResetPasswordPage.vue'), meta: { public: true } },
      { path: '/403', component: () => import('@/pages/ForbiddenPage.vue'), meta: { public: true } },
      // App (authenticated — guard redirects to /login when AUTH_MODE=api-key)
      { path: '/documents', component: () => import('@/pages/DocumentsListPage.vue') },
      { path: '/documents/:id', component: () => import('@/pages/DocumentDetailPage.vue') },
      { path: '/documents/:id/edit', component: () => import('@/pages/EditorPage.vue') },
      { path: '/create', component: () => import('@/pages/EditorPage.vue') },
      { path: '/upload', component: () => import('@/pages/UploadPage.vue') },
      { path: '/search', component: () => import('@/pages/SearchPage.vue') },
      { path: '/activity', component: () => import('@/pages/ActivityPage.vue') },
      { path: '/assistant', component: () => import('@/pages/AssistantPage.vue') },
      // Access control (page gates mutations by workspace role)
      { path: '/access', component: () => import('@/pages/AccessControlPage.vue') },
      // Users management (platform admin only → /403 otherwise)
      { path: '/admin/users', component: () => import('@/pages/AdminUsersPage.vue'), meta: { platformAdmin: true } },
    ],
  })
}

/**
 * Auth guard (runs on SSR and client): resolves /v1/me once, then
 * - unauthenticated on a protected route → /login (401 flow)
 * - authenticated on /login|/signup → /documents
 * - non-platform-admin on an admin route → /403 (RBAC)
 */
export function installAuthGuard(router: Router, pinia: Pinia) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore(pinia)
    await auth.ensureLoaded()
    if (auth.authenticated && (to.path === '/login' || to.path === '/signup')) {
      return { path: '/documents' }
    }
    if (to.meta.public) return true
    if (!auth.authenticated) {
      return { path: '/login', query: to.fullPath === '/documents' ? {} : { redirect: to.fullPath } }
    }
    if (to.meta.platformAdmin && !auth.isAdmin && !auth.isDev) return { path: '/403' }
    return true
  })
}
