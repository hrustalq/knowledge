import type { RouteRecordRaw } from 'vue-router'

export const routes: RouteRecordRaw[] = [
  // Auth flow (public). `authCard`: one card in one unchanging shell, so a
  // move between any two of them animates the card and not the page — see
  // the cardSwap branch in installViewTransitions().
  { path: '/login', component: () => import('./pages/LoginPage.vue'), meta: { public: true, authCard: true } },
  { path: '/signup', component: () => import('./pages/SignupPage.vue'), meta: { public: true, authCard: true } },
  { path: '/forgot-password', component: () => import('./pages/ForgotPasswordPage.vue'), meta: { public: true, authCard: true } },
  { path: '/reset-password', component: () => import('./pages/ResetPasswordPage.vue'), meta: { public: true, authCard: true } },
  { path: '/verify-email', component: () => import('./pages/VerifyEmailPage.vue'), meta: { public: true, authCard: true } },
  // The end of an SSO round trip (#75): trades the fragment code for a session.
  { path: '/auth/sso/complete', component: () => import('./pages/SsoCompletePage.vue'), meta: { public: true, authCard: true } },
  { path: '/403', component: () => import('./pages/ForbiddenPage.vue'), meta: { public: true } },
  // A member signing in to a published site (issue #77 phase 3): needs the
  // app's session, so the guard sends anyone signed out through /login.
  { path: '/site-sign-in', component: () => import('./pages/SiteSignInPage.vue') },
]
