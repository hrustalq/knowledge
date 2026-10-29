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
import { useFeaturesStore } from '@/stores/features'
import { isWorkspaceFeature } from '@knowledge/contracts'
import { reauthKindOf } from '@/modules/auth'
import * as access from '@/modules/access/routes'
import * as apiReference from '@/modules/api-reference/routes'
import * as assistant from '@/modules/assistant/routes'
import * as auth from '@/modules/auth/routes'
import * as captures from '@/modules/captures/routes'
import * as connectors from '@/modules/connectors/routes'
import * as documents from '@/modules/documents/routes'
import * as editor from '@/modules/editor/routes'
import * as help from '@/modules/help/routes'
import * as insights from '@/modules/insights/routes'
import * as memos from '@/modules/memos/routes'
import * as mergeRequests from '@/modules/merge-requests/routes'
import * as notifications from '@/modules/notifications/routes'
import * as projects from '@/modules/projects/routes'
import * as publishing from '@/modules/publishing/routes'
import * as templates from '@/modules/templates/routes'
import * as workflows from '@/modules/workflows/routes'

export function createRouter() {
  return createVueRouter({
    history: import.meta.env.SSR ? createMemoryHistory() : createWebHistory(),
    routes: [
      { path: '/', redirect: '/documents' },
      ...auth.routes,
      ...connectors.routes,
      ...documents.routes,
      ...editor.routes,
      ...apiReference.routes,
      ...notifications.routes,
      ...access.routes,
      ...mergeRequests.routes,
      ...workflows.routes,
      ...insights.routes,
      ...captures.routes,
      ...memos.routes,
      ...assistant.routes,
      // Settings: shell with its own right-hand nav; the sections are nested pages.
      {
        path: '/settings',
        component: () => import('@/app/shell/SettingsPage.vue'),
        children: [
          { path: '', redirect: '/settings/projects' },
          ...access.settingsRoutes,
          ...notifications.settingsRoutes,
          {
            ...projects.settingsRoute,
            // Third rail: the roster lives in the shell, the selection here. A
            // project's site settings are publishing's page; nesting it is the
            // router's job, since modules never import each other.
            children: [...publishing.projectSiteRoutes, projects.projectDetailRoute],
          },
          ...documents.settingsRoutes,
          ...templates.settingsRoutes,
          ...publishing.settingsRoutes,
          ...apiReference.settingsRoutes,
          ...workflows.settingsRoutes,
          // Connect AI is access's page among the assistant's sections: the
          // same nesting as projects ← publishing above.
          { ...assistant.aiSettingsRoute, children: [...assistant.aiSectionRoutes, access.connectAiRoute] },
          ...connectors.settingsRoutes,
          ...help.settingsRoutes,
        ],
      },
      ...projects.routes,
      ...help.routes,
    ],
  })
}

/**
 * Auth guard (runs on SSR and client): resolves /v1/me once, then
 * - unauthenticated on a protected route → /login (401 flow)
 * - authenticated on /login|/signup → /documents, unless /login was asked to
 *   sign them in again (`?reauth=`, a workspace's sign-in policy, #75) — the
 *   bounce back would 403 straight into /login again, forever
 * - non-platform-admin on an admin route → /403 (RBAC)
 * - unconfirmed address under AUTH_REQUIRE_VERIFIED_EMAIL → /verify-email
 *   (docs/features/41); every other route would only answer 403 anyway
 * - a route whose `meta.feature` the workspace switched off (#604) → /documents
 */
export function installAuthGuard(router: Router, pinia: Pinia) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore(pinia)
    await auth.ensureLoaded()
    if (auth.authenticated && ((to.path === '/login' && !reauthKindOf(to.query.reauth)) || to.path === '/signup')) {
      return { path: '/documents' }
    }
    if (to.meta.public) return true
    if (!auth.authenticated) {
      return { path: '/login', query: to.fullPath === '/documents' ? {} : { redirect: to.fullPath } }
    }
    // Before the features read: a gated account would only collect a 403 for it.
    if (auth.verificationPending) return { path: '/verify-email' }
    const features = useFeaturesStore(pinia)
    await features.ensureLoaded()
    return refusal(to, auth, features) ?? true
  })
}

/**
 * Where a signed-in caller who may not open `to` is sent instead, or null.
 * The guard and the route prefetcher (./navigation.ts) both ask, so a chunk is
 * never fetched for a route the guard would turn away.
 */
export function refusal(
  to: Pick<RouteLocationNormalized, 'meta' | 'matched'>,
  auth: ReturnType<typeof useAuthStore>,
  features: ReturnType<typeof useFeaturesStore>,
): { path: string } | null {
  if (auth.verificationPending) return { path: '/verify-email' }
  if (to.meta.platformAdmin && !auth.isAdmin && !auth.isDev) return { path: '/403' }
  // A section the workspace switched off (#604) is not there: home, not a 404,
  // since the link that led here was the app's own until the switch.
  const feature = to.matched.map((r) => r.meta.feature).find(isWorkspaceFeature)
  if (feature && !features.isOn(feature)) return { path: '/documents' }
  return null
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

    // Sign in ↔ create account is not a change of place: the shell, the logo
    // and the card's own header stay exactly where they are, and only the
    // card's size and fields differ. The signed-out shell animates that swap
    // itself with an ordinary Vue <Transition> (see app/App.vue), so this stands
    // aside rather than running a second mechanism across the same moment —
    // two of them snapshotting one swap fight, and the capture freezes the
    // card the other one is trying to move.
    if (to.meta.authCard && from.meta.authCard) {
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
        //
        // One tick and no longer. Holding this callback open across a further
        // await keeps it pending while Vue unmounts the old tree, and a named
        // element that leaves the DOM mid-capture fails the whole transition
        // with an InvalidStateError on `ready` — which shows up as no animation
        // rather than as an error. Measured, not assumed.
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
 * The reading order of the auth cards, and so which way one slides to reach the
 * next. Exported because the shell animates this swap, not the router.
 *
 * Deliberately not `directionBetween`: all four routes are one segment deep, so
 * depth cannot separate them, and history would answer differently depending on
 * how you arrived — the same two cards sliding left on a click and right on
 * Back. Tabs do not behave that way, and this is a row of tabs. A fixed order
 * makes sign-in ⇄ create-account one movement and its exact reverse, whichever
 * way you got there.
 *
 * A path that is not on the list — /403 shares this shell — sorts after every
 * path that is, so arriving reads as going forward and leaving as coming back.
 */
const AUTH_ORDER = ['/login', '/signup', '/forgot-password', '/reset-password', '/verify-email']

export function authSlideDirection(toPath: string, fromPath: string): 'fwd' | 'back' {
  const rank = (path: string) => {
    const i = AUTH_ORDER.indexOf(path)
    return i === -1 ? AUTH_ORDER.length : i
  }
  return rank(toPath) < rank(fromPath) ? 'back' : 'fwd'
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
