<script setup lang="ts">
/**
 * The authenticated shell: navigation rail, topbar, breadcrumb strip, and the
 * scrolling content column every page lands in.
 *
 * Lifted out of app/App.vue, which now does one thing — choose between the
 * signed-out card and this. The move is what lets the shell answer a question
 * it could not answer while it was one branch of a template: how tall its own
 * chrome is. Five places downstream used to hardcode that as `5.75rem` (topbar
 * plus breadcrumb strip) in order to size a column against the rest of the
 * viewport, and the breadcrumb strip is conditional — so the constant was
 * simply wrong on any route without a trail. `--kn-chrome-h` is published from
 * the chrome actually rendered, and the sub-rails read it.
 */
import { computed, onBeforeUnmount, ref, useSSRContext, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { FocusScope } from 'reka-ui'
import { Toaster } from '@/shared/ui/sonner'
import { useSidebarStore } from '@/stores/sidebar'
import { useLayoutStore } from '@/stores/layout'
import { SearchSheet, useSearchUiStore } from '@/modules/documents'
import { useAuthStore } from '@/stores/auth'
import { useTemplatesStore } from '@/entities/template'
import { TemplateGalleryDialog } from '@/modules/templates'
import AppSidebar from './AppSidebar.vue'
import VerifyEmailBanner from './VerifyEmailBanner.vue'
import AppTopbar from './AppTopbar.vue'
import AppBreadcrumbs from './AppBreadcrumbs.vue'
import { useCrumbs } from './breadcrumbs'
import { APP_NAME, titleFor } from './document-title'
import { slowNavigation } from '@/app/router/navigation'

const route = useRoute()
const { t } = useI18n()

/**
 * The template gallery (issue #69) is opened from the tree and the editor,
 * which know nothing of each other, so it lives here once. Loaded on first
 * open and kept after, so its preview pipeline is not in every page's bundle
 * and closing it still animates.
 */
const templates = useTemplatesStore()
const galleryMounted = ref(false)
watch(
  () => templates.gallery.open,
  (open) => {
    if (open) galleryMounted.value = true
  },
)

/**
 * The search sheet, the same way (the documents index exports it async): its filters, comboboxes and result renderer
 * were a third of the chunks the shell preloaded on every first load (#279),
 * for a surface nobody has opened yet.
 */
const searchUi = useSearchUiStore()
const searchMounted = ref(false)
watch(
  () => searchUi.open,
  (open) => {
    if (open) searchMounted.value = true
  },
)
const sidebar = useSidebarStore()
const layout = useLayoutStore()
const crumbs = useCrumbs()

/**
 * `meta.bare`: writing surfaces supply their own header, so the app trail would
 * just be a second, competing one. Otherwise the strip is drawn only when there
 * is a trail to draw — which is the condition that used to live inside
 * AppBreadcrumbs, moved out so exactly one place decides it and the height
 * below can follow.
 */
const showCrumbs = computed(() => !route.meta.bare && crumbs.value.length > 0)

/**
 * The tab title names the route (#644). The server reads it after the render,
 * once the prefetches have filled what the trail names; signed out, the tab
 * goes back to the app's name.
 */
const documentTitle = computed(() => titleFor(crumbs.value))
if (import.meta.env.SSR) {
  const ssr = useSSRContext<{ title?: () => string }>()
  if (ssr) ssr.title = () => documentTitle.value
} else {
  watchEffect(() => (document.title = documentTitle.value))
  onBeforeUnmount(() => (document.title = APP_NAME))
}

/** An unconfirmed address (docs/features/41), until dismissed for this load. */
const auth = useAuthStore()
const bannerDismissed = ref(false)
const showVerifyBanner = computed(
  () => !!auth.me && auth.me.mode !== 'dev' && !auth.me.emailVerified && !bannerDismissed.value,
)

/**
 * `h-14` topbar and `h-10` verify banner, in the unit the consumers want. The
 * trail row adds `--kn-trail-h` and the editor's bar under it (#441)
 * `--kn-toolbar-h`, both set by the stylesheet: the trail row is drawn for a
 * trail *or* for page actions, and only the page knows whether it has those,
 * which CSS can answer on the server's first frame.
 */
const TOPBAR_REM = 3.5
const BANNER_REM = 2.5
const chromeHeight = computed(
  () =>
    `calc(${TOPBAR_REM + (showVerifyBanner.value ? BANNER_REM : 0)}rem + var(--kn-trail-h, 0rem) + var(--kn-toolbar-h, 0rem))`,
)

/**
 * Desktop: collapsible rail; mobile: off-canvas drawer. The desktop half of
 * that lives in the sidebar store because its width and open state are drawn
 * by the server on the first frame — see lib/api's rail accessors.
 */
const mobileOpen = ref(false)

const railOpen = computed(() => sidebar.open)

function toggleSidebar() {
  if (!window.matchMedia('(min-width: 1024px)').matches) {
    mobileOpen.value = !mobileOpen.value
    return
  }
  sidebar.toggle()
}
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  },
)

/**
 * The skip link moves focus rather than following its `#main` hash: a hash
 * change is a navigation to the router, which would replay the route's scroll
 * and view transition just to move the caret. The href stays for no-JS.
 */
const mainEl = ref<HTMLElement | null>(null)
function skipToMain() {
  mainEl.value?.focus()
}
</script>

<template>
  <!-- `h-dvh`, not `h-screen`: on iOS `100vh` is the toolbar-hidden height,
       so a fill route's footer (a chat composer) sat under Safari's toolbar. -->
  <div
    class="kn-shell relative flex h-dvh overflow-hidden bg-background text-foreground"
    :class="sidebar.resizing ? 'kn-resizing' : ''"
    :style="{ '--kn-rail-w': sidebar.widthPx, '--kn-chrome-h': chromeHeight }"
    :data-rail-open="railOpen"
    :data-measure="layout.fullWidth ? undefined : 'narrow'"
  >
    <!-- First in tab order. Off-canvas rather than `sr-only` until focused, so
         it slides in on the first Tab instead of popping into the layout. -->
    <a
      href="#main"
      class="fixed left-2 top-2 z-[60] -translate-y-[calc(100%+1rem)] rounded-md border bg-popover px-3 py-2 text-sm font-medium text-popover-foreground shadow-md transition-transform focus:translate-y-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
      @click.prevent="skipToMain"
    >
      {{ t('nav.skipToContent') }}
    </a>
    <!--
      The rail collapses as two elements: a flex spacer that reserves the
      column, and the rail itself sliding out to the left with a transform.
      The spacer snaps rather than animating its width — a width transition
      re-lays out the whole content column on every frame — so the content
      moves once, behind the opaque rail, while the rail slides. Animating the
      rail's own width would be worse still: a 16rem column re-wrapping every
      label as it leaves.
    -->
    <div class="kn-rail-gap hidden shrink-0 lg:block" aria-hidden="true" />
    <div
      class="kn-rail absolute inset-y-0 left-0 z-20 hidden lg:block"
      :inert="!railOpen || undefined"
    >
      <AppSidebar />
    </div>

    <!-- Mobile drawer: the same rail, arriving as a drawer over a scrim. It is
         a modal while open, so it behaves as one: FocusScope moves focus in,
         keeps Tab inside and hands focus back to the toggle on close, Escape
         closes it, and the column behind is `inert` (as the collapsed desktop
         rail is) so nothing under the scrim can be reached. -->
    <Transition name="drawer" :duration="260">
      <div v-if="mobileOpen" class="fixed inset-0 z-40 lg:hidden" @keydown.esc="mobileOpen = false">
        <div
          class="kn-drawer-scrim absolute inset-0 bg-black/40"
          aria-hidden="true"
          @click="mobileOpen = false"
        />
        <FocusScope as-child trapped loop>
          <div
            role="dialog"
            aria-modal="true"
            :aria-label="t('nav.navigation')"
            class="kn-drawer-panel absolute inset-y-0 left-0 h-full shadow-[0_16px_48px_-12px_rgb(0_0_0/0.45)]"
            :style="{ width: 'min(var(--kn-rail-w), 88vw)' }"
          >
            <AppSidebar />
          </div>
        </FocusScope>
      </div>
    </Transition>

    <div class="flex min-w-0 flex-1 flex-col" :inert="mobileOpen || undefined">
      <AppTopbar @toggle-sidebar="toggleSidebar" />
      <VerifyEmailBanner
        v-if="showVerifyBanner && auth.me"
        :email="auth.me.email"
        @dismiss="bannerDismissed = true"
      />
      <!-- The trail row: where you are on the left, what you can do to it on
           the right. A page teleports its actions into the end slot, so they
           share the trail's row instead of stacking a second strip under it,
           and stay outside the scroller — always visible, and an anchor jump
           never lands under them. Both targets are always rendered, so a
           teleport never misses one; each is drawn only while it holds
           something. `id` stays the first attribute: entry-server splices the
           server's teleport buffers in by it. -->
      <div class="kn-trail">
        <AppBreadcrumbs v-if="showCrumbs" :crumbs="crumbs" />
        <div id="kn-page-actions" class="kn-page-actions" />
      </div>
      <!-- The editor's bar (#441): the state of the edit on the left, its acts on
           the right, the formatting toolbar directly beneath — too much to share
           the trail's row, so it keeps a row of its own. -->
      <div id="kn-page-toolbar" class="kn-page-toolbar" />
      <!--
        Two content modes.

        By default the column is a document: `min-h-full` lets it grow with its
        content, its padding frames the page, and <main> does the scrolling. A
        route with `meta.fill` is a surface instead — a chat, a canvas — that
        owns the viewport and scrolls something inside itself. That needs a
        *definite* height rather than a minimum, because `flex-1` and
        percentage heights under an auto-height parent resolve from content:
        a fill page would push this column taller and scroll the whole page
        instead of its own panel. `h-full` with no padding is what lets every
        height inside such a page resolve, and it spares those pages both the
        negative-margin bleed and any guess at how tall the chrome above them
        happens to be on a given route.
      -->
      <!-- Pane 1: the outermost thing a route change can replace. The name is
           put on the scroller rather than on the column inside it because
           <main> is bounded by the viewport, so its snapshot is one screen —
           the column grows with the document, and a long page would ask the
           compositor for a texture several thousand pixels tall on every
           navigation. See markChangedPane() in router/index.ts. -->
      <!-- A navigation still waiting on its chunk (#627); see .kn-route-progress. -->
      <div v-if="slowNavigation" class="kn-route-progress" role="progressbar" :aria-label="t('nav.loadingPage')" />
      <main
        id="main"
        ref="mainEl"
        tabindex="-1"
        data-kn-pane="1"
        :class="['flex-1 outline-none', route.meta.fill ? 'overflow-hidden' : 'overflow-y-auto']"
      >
        <div
          :class="[
            'flex w-full flex-col',
            route.meta.fill ? 'h-full' : 'min-h-full px-4 py-6 lg:px-8',
          ]"
        >
          <RouterView />
        </div>
      </main>
    </div>
    <SearchSheet v-if="searchMounted" />
    <TemplateGalleryDialog v-if="galleryMounted" />
    <Toaster />
  </div>
</template>

<style>
/*
 * A navigation still waiting on its route's chunk (#627): a 2px ink run along
 * the top edge of the content pane. Zero-height host, so drawing it moves
 * nothing; it fades in, since it only appears once a wait has already lasted.
 * Reduced motion keeps a still rule — the wait is still worth saying. Here
 * rather than in style.css, which the public reader ships too.
 */
.kn-route-progress {
  position: relative;
  z-index: 10;
  height: 0;
  pointer-events: none;
}
.kn-route-progress::before {
  content: '';
  position: absolute;
  inset-inline: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--primary) 30%, var(--primary) 70%, transparent) no-repeat;
  background-size: 40% 100%;
  animation:
    kn-route-progress-in 160ms ease-out both,
    kn-route-progress-run 1.1s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
@keyframes kn-route-progress-in {
  from {
    opacity: 0;
  }
}
@keyframes kn-route-progress-run {
  from {
    background-position: -70% 0;
  }
  to {
    background-position: 170% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .kn-route-progress::before {
    background: var(--primary);
    opacity: 0.5;
    animation: none;
  }
}
</style>
