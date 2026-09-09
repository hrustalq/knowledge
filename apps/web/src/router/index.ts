import { nextTick } from 'vue'
import {
  createMemoryHistory,
  createRouter as createVueRouter,
  createWebHistory,
  type RouteLocationNormalized,
  type Router,
} from 'vue-router'
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
      // meta.fill: the pages landing leads with a graph canvas, which needs a
      // definite height to resolve; the tree and list views scroll inside it.
      { path: '/documents', component: () => import('@/pages/DocumentsListPage.vue'), meta: { fill: true } },
      { path: '/documents/:id', component: () => import('@/pages/DocumentDetailPage.vue') },
      // `fill`: the editor owns the viewport and scrolls its own prose column.
      // `bare`: no breadcrumbs — while writing, the only chrome is the page's own.
      {
        path: '/documents/:id/edit',
        component: () => import('@/pages/EditorPage.vue'),
        meta: { fill: true, bare: true },
      },
      { path: '/create', component: () => import('@/pages/EditorPage.vue'), meta: { fill: true, bare: true } },
      // /upload keeps its path so every existing link, bookmark and sidebar
      // shortcut still lands; /import is the name the flow now goes by.
      // meta.fill: the wizard owns the viewport — its three steps share one
      // frame with a fixed header and action bar, and step 3 holds an editor
      // that scrolls itself. Breadcrumbs stay: unlike the editor this is not a
      // writing surface, and the trail is the only orientation it has.
      {
        path: '/upload',
        alias: '/import',
        component: () => import('@/pages/ImportPage.vue'),
        meta: { fill: true },
      },
      { path: '/search', component: () => import('@/pages/SearchPage.vue') },

      // A person, inside this workspace. `/u` with no id is your own — the
      // avatar menu's target, and a link that stays right after a rename.
      { path: '/u', component: () => import('@/pages/ProfilePage.vue') },
      { path: '/u/:userId', component: () => import('@/pages/ProfilePage.vue') },
      { path: '/merge-requests', component: () => import('@/pages/MergeRequestsPage.vue') },
      { path: '/merge-requests/:id', component: () => import('@/pages/MergeRequestDetailPage.vue') },
      // Creating and editing a workflow (docs/features/17).
      //
      // Declared at the top level while keeping the `/settings/workflows/…`
      // path: the URL still reads as workspace administration, but rendering
      // inside the settings shell would put a second navigation rail beside the
      // builder's step palette and box the canvas into a column again — which
      // is exactly what this rebuild was for. `meta.fill` gives each the
      // viewport; `meta.bare` drops the app trail, because both carry a header
      // that already says where you are and offers the way back.
      {
        path: '/settings/workflows/new',
        component: () => import('@/pages/WorkflowWizardPage.vue'),
        meta: { fill: true, bare: true },
      },
      {
        path: '/settings/workflows/:id/edit',
        component: () => import('@/pages/WorkflowBuilderPage.vue'),
        meta: { fill: true, bare: true },
      },

      // Workflows (docs/features/17): the run list, and one run's node tree.
      { path: '/workflows', component: () => import('@/pages/WorkflowsPage.vue') },
      { path: '/workflows/:id', component: () => import('@/pages/WorkflowRunPage.vue') },
      // meta.fill: the chat owns the viewport — see App.vue's two content modes.
      { path: '/assistant', component: () => import('@/pages/AssistantPage.vue'), meta: { fill: true } },
      // Settings: shell with its own right-hand nav; the sections are nested pages.
      {
        path: '/settings',
        component: () => import('@/pages/SettingsPage.vue'),
        children: [
          { path: '', redirect: '/settings/projects' },
          // Your own account: name, language, password, API key. Open to every
          // role — it takes no user id, so there is nobody else to act on.
          { path: 'profile', component: () => import('@/pages/ProfileSettingsPage.vue') },
          {
            path: 'projects',
            component: () => import('@/pages/ProjectsPage.vue'),
            // Third rail: the roster lives in the shell, the selection here.
            children: [{ path: ':id?', component: () => import('@/pages/ProjectDetailPage.vue') }],
          },
          // Glossary: workspace vocabulary; the page gates writes on the
          // editor role, and reading it is open to any member.
          { path: 'glossary', component: () => import('@/pages/GlossaryPage.vue') },
          // Workflows: like AI settings, deliberately not meta.platformAdmin —
          // this is workspace administration, so the page gates on
          // auth.canAdminWorkspace and the API enforces the admin role.
          // Deliberately not meta.fill: that drops <main>'s padding, which the
          // settings shell's negative-margin bleed depends on. The workbench
          // bounds its own panes instead.
          { path: 'workflows', component: () => import('@/pages/WorkflowSettingsPage.vue') },
          // Access control (page gates mutations by workspace role)
          { path: 'access', component: () => import('@/pages/AccessControlPage.vue') },
          { path: 'activity', component: () => import('@/pages/ActivityPage.vue') },
          // AI: provider config, skills, MCP plugins, token usage and call log.
          // Gated in the page on workspace admin rather than meta.platformAdmin —
          // these are workspace settings, not platform ones.
          { path: 'ai', component: () => import('@/pages/AiSettingsPage.vue') },
          // Connectors (docs/features/19): workspace administration, so like AI
          // settings it gates on auth.canAdminWorkspace rather than meta.platformAdmin.
          { path: 'connectors', component: () => import('@/pages/ConnectorsPage.vue') },
          // Users management (platform admin only → /403 otherwise)
          { path: 'users', component: () => import('@/pages/AdminUsersPage.vue'), meta: { platformAdmin: true } },
          // Docs: the product manual, bundled with the build it describes.
          // Same shell-plus-roster shape as projects — the rail lives here, the
          // article in the child, so switching articles replaces one pane.
          // Open to everyone: documentation nobody may read documents nothing.
          {
            path: 'docs',
            component: () => import('@/pages/DocsPage.vue'),
            children: [{ path: ':slug?', component: () => import('@/pages/DocsArticlePage.vue') }],
          },
        ],
      },
      // Legacy top-level paths → their settings home
      { path: '/projects', redirect: '/settings/projects' },
      { path: '/glossary', redirect: '/settings/glossary' },
      { path: '/activity', redirect: '/settings/activity' },
      { path: '/access', redirect: '/settings/access' },
      { path: '/admin/users', redirect: '/settings/users' },
      { path: '/docs', redirect: '/settings/docs' },
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

/**
 * A route change is a place change, so it gets a horizontal push — of the pane
 * that actually changed, and only that pane.
 *
 * Which pane that is comes from `matched`, not from the URL. `/documents` and
 * `/documents/:id` are sibling records rendered by the outer view, so the whole
 * content column changes; `/settings/glossary` and `/settings/ai` are children
 * of one shell, so the settings nav beside them did *not* change and must not
 * travel with them. Path segments cannot tell those two cases apart — both look
 * like "one segment differs" — but the matched record list can: the first index
 * where the two navigations disagree is the pane that is being replaced.
 *
 * `beforeResolve`, not `beforeEach`, and that is the whole reason this is
 * usable: every route here is a lazy `import()`, and `beforeResolve` runs after
 * the chunk has resolved. Started any earlier, the transition would snapshot the
 * old page and then hold that frozen image for the length of a network fetch — a
 * first visit to a route would look like the app had hung.
 *
 * Where `startViewTransition` is missing the navigation simply happens, which is
 * what it did before. Nothing here is load-bearing for correctness.
 */
export function installViewTransitions(router: Router) {
  if (import.meta.env.SSR) return

  const supported = typeof document !== 'undefined' && 'startViewTransition' in document

  router.beforeResolve((to, from) => {
    // Same page, new query or hash: a filter changing is not an arrival, and
    // sliding the page under someone typing into it would be absurd.
    if (to.path === from.path) return true

    if (!supported) {
      void nextTick(() => resetScroll(to))
      return true
    }

    // Both are set before the capture: the name decides what is snapshotted and
    // the direction decides which way it travels, and `startViewTransition`
    // captures the moment it is called.
    const level = changedLevel(to, from)
    namePane(level)
    document.documentElement.dataset.navDir = directionBetween(to, from)

    return new Promise<true>((resolve) => {
      const transition = document.startViewTransition(async () => {
        // Let the navigation finish, then wait for the DOM it produces — that
        // awaited render is what the API captures as the "new" state.
        resolve(true)
        await nextTick()
        // Again, because the pane may be a different element now: signing in
        // swaps the whole shell, so the <main> that was captured is gone and
        // its replacement has to carry the name for the arrival half.
        namePane(level)
        resetScroll(to)
      })
      // A second navigation before the first has finished skips this one, and a
      // skipped transition rejects. That is ordinary, not an error.
      transition.ready.catch(() => {})
      transition.finished
        .catch(() => {})
        .finally(() => {
          document.documentElement.removeAttribute('data-nav-dir')
          clearPaneNames()
        })
    })
  })
}

/**
 * Hands the single `kn-page` transition name to the pane being replaced.
 *
 * It is one name moved around rather than a name per level because only one
 * pane is ever replaced by a navigation, and because a *nested* name would make
 * things worse rather than better: a named child is lifted out of its parent's
 * snapshot, so an inner pane that kept its name while an outer pane travelled
 * would sit still while the shell around it slid away.
 *
 * The name is applied twice, once for each half of the capture: before the DOM
 * updates so the outgoing pane carries it, and again afterwards because the
 * element may have been replaced in between — signing in swaps the entire shell,
 * <main> included.
 */
function changedLevel(to: RouteLocationNormalized, from: RouteLocationNormalized): number {
  let level = 1
  while (
    level <= to.matched.length &&
    level <= from.matched.length &&
    to.matched[level - 1] === from.matched[level - 1]
  ) {
    level++
  }
  return level
}

/** Hands the name to the pane at `level`, taking it off every other one. */
function namePane(level: number) {
  const panes = clearPaneNames()
  // A route can nest deeper than any shell that renders a pane, in which case
  // the innermost pane on screen is the one being replaced.
  const target =
    document.querySelector<HTMLElement>(`[data-kn-pane="${level}"]`) ?? panes[panes.length - 1]
  target?.style.setProperty('view-transition-name', 'kn-page')
}

function clearPaneNames(): HTMLElement[] {
  const panes = [...document.querySelectorAll<HTMLElement>('[data-kn-pane]')]
  panes.forEach((el) => el.style.removeProperty('view-transition-name'))
  return panes
}

/**
 * Which way the pane travels.
 *
 * The sidebar already answers this question for its own navigation stack, and
 * the answer there is the app's one authored movement: a pane going deeper rides
 * in from the right while the one it covers recedes a much shorter distance. The
 * inequality is the whole effect — equal travel reads as a carousel, unequal
 * travel reads as depth — and a route change is the same gesture at a larger
 * scale, so it gets the same treatment rather than a second idiom.
 *
 * Depth decides it, and depth is how many segments the route has: `/documents`
 * to `/documents/:id` is a push, and the way back is a pop.
 *
 * Two routes at the same depth are neither deeper nor shallower — one settings
 * section to the next, or one top-level area to another. They still travel,
 * because a page that only cross-fades reads as a redraw rather than as a move,
 * and Back is the one thing that reliably says which way sideways went: browser
 * history breaks the tie, and everything else reads as going forward.
 */
function directionBetween(
  to: RouteLocationNormalized,
  from: RouteLocationNormalized,
): 'push' | 'pop' {
  const depth = (path: string) => path.split('/').filter(Boolean).length
  const d = depth(to.path) - depth(from.path)
  if (d !== 0) return d > 0 ? 'push' : 'pop'
  return wentBack(to, from) ? 'pop' : 'push'
}

/**
 * Whether this navigation is the browser going backwards, read off the history
 * entry rather than off a popstate listener.
 *
 * A listener does not work here: popstate fires *after* the guards run, so a
 * flag set from it arrives one navigation late and ends up describing the move
 * after the one it was meant for — which is how a forward click came to play the
 * back animation.
 *
 * Vue Router keeps `{ back, current, forward }` on the history entry, and by the
 * time a guard runs the browser has already moved to the target entry for a
 * history navigation but not for a push. So `current === to` is what identifies a
 * history navigation at all, and from there the page being left sitting in
 * `forward` is what makes it a backwards one.
 */
function wentBack(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
  const state = window.history.state as { current?: string; forward?: string } | null
  if (!state || state.current !== to.fullPath) return false
  return state.forward === from.fullPath
}

/**
 * `<main>` is the scroller, not the window, so `scrollBehavior` cannot reach it
 * — and because `<main>` lives in the shell it survives the route change with
 * its old `scrollTop` intact. Without this you arrive on a new page already
 * scrolled to wherever you had left the previous one, which the travel makes
 * impossible to miss.
 *
 * A hash is left alone: it is an instruction about where to land, and whatever
 * honours it should not be fighting a reset.
 */
function resetScroll(to: RouteLocationNormalized) {
  if (to.hash) return
  const main = document.querySelector('main')
  if (main) main.scrollTop = 0
}
