<script setup lang="ts">
/**
 * The authenticated shell: navigation rail, topbar, breadcrumb strip, and the
 * scrolling content column every page lands in.
 *
 * Lifted out of App.vue, which now does one thing — choose between the
 * signed-out card and this. The move is what lets the shell answer a question
 * it could not answer while it was one branch of a template: how tall its own
 * chrome is. Five places downstream used to hardcode that as `5.75rem` (topbar
 * plus breadcrumb strip) in order to size a column against the rest of the
 * viewport, and the breadcrumb strip is conditional — so the constant was
 * simply wrong on any route without a trail. `--kn-chrome-h` is published from
 * the chrome actually rendered, and the sub-rails read it.
 */
import { computed, ref, watch } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import SearchSheet from '@/components/knowledge/SearchSheet.vue'
import { useSidebarStore } from '@/stores/sidebar'
import AppSidebar from './AppSidebar.vue'
import AppTopbar from './AppTopbar.vue'
import AppBreadcrumbs from './AppBreadcrumbs.vue'
import { useCrumbs } from './breadcrumbs'

const route = useRoute()
const sidebar = useSidebarStore()
const crumbs = useCrumbs()

/**
 * `meta.bare`: writing surfaces supply their own header, so the app trail would
 * just be a second, competing one. Otherwise the strip is drawn only when there
 * is a trail to draw — which is the condition that used to live inside
 * AppBreadcrumbs, moved out so exactly one place decides it and the height
 * below can follow.
 */
const showCrumbs = computed(() => !route.meta.bare && crumbs.value.length > 0)

/** `h-14` on the topbar and `h-9` on the strip, in the unit the consumers want. */
const TOPBAR_REM = 3.5
const CRUMBS_REM = 2.25
const chromeHeight = computed(
  () => `${showCrumbs.value ? TOPBAR_REM + CRUMBS_REM : TOPBAR_REM}rem`,
)

/**
 * Desktop: collapsible rail; mobile: off-canvas drawer. The desktop half of
 * that lives in the sidebar store because its width and open state are drawn
 * by the server on the first frame — see lib/api's rail accessors.
 */
const mobileOpen = ref(false)

/**
 * The editor's assistant panel takes the rail's place on the left edge
 * (docs/features/34). Derived here from the route and the panel's cookie-backed
 * state rather than set by the page, because the shell renders before the page
 * does: a page that hid the rail from its own setup would be too late for the
 * server's frame, and the rail would slide shut on every load.
 */
const railYielded = computed(() => route.meta.assistantPanel === true && sidebar.aiPanelOpen)
const railOpen = computed(() => sidebar.open && !railYielded.value)

function toggleSidebar() {
  if (!window.matchMedia('(min-width: 1024px)').matches) {
    mobileOpen.value = !mobileOpen.value
    return
  }
  // Asking for the rail while the panel holds its place means "give me
  // navigation back": the panel closes and the rail returns as it was left.
  if (railYielded.value) {
    sidebar.setAiPanel(false)
    if (!sidebar.open) sidebar.setOpen(true)
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
</script>

<template>
  <div
    class="relative flex h-screen overflow-hidden bg-background text-foreground"
    :class="sidebar.resizing ? 'kn-resizing' : ''"
    :style="{ '--kn-rail-w': sidebar.widthPx, '--kn-chrome-h': chromeHeight }"
    :data-rail-open="railOpen"
  >
    <!--
      The rail collapses as two elements moving on one curve: a flex spacer
      that closes the column, and the rail itself sliding out to the left over
      it. Animating the rail's own width instead would reflow every label
      inside it for the whole travel — a 16rem column re-wrapping as it leaves,
      which is exactly why an instant `v-if` used to look better than a
      transition. Here nothing inside the rail moves relative to the rail; the
      spacer's right edge and the rail's right edge sit at the same x on every
      frame, so the content column reads as being uncovered rather than pushed.
    -->
    <div class="kn-rail-gap hidden shrink-0 lg:block" aria-hidden="true" />
    <div
      class="kn-rail absolute inset-y-0 left-0 z-20 hidden lg:block"
      :inert="!railOpen || undefined"
    >
      <AppSidebar />
    </div>

    <!-- Mobile drawer: the same rail, arriving as a drawer over a scrim. -->
    <Transition name="drawer" :duration="260">
      <div v-if="mobileOpen" class="fixed inset-0 z-40 lg:hidden">
        <div
          class="kn-drawer-scrim absolute inset-0 bg-black/40"
          aria-hidden="true"
          @click="mobileOpen = false"
        />
        <div
          class="kn-drawer-panel absolute inset-y-0 left-0 h-full shadow-[0_16px_48px_-12px_rgb(0_0_0/0.45)]"
          :style="{ width: 'min(var(--kn-rail-w), 88vw)' }"
        >
          <AppSidebar />
        </div>
      </div>
    </Transition>

    <div class="flex min-w-0 flex-1 flex-col">
      <AppTopbar @toggle-sidebar="toggleSidebar" />
      <AppBreadcrumbs v-if="showCrumbs" :crumbs="crumbs" />
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
      <main
        data-kn-pane="1"
        :class="['flex-1', route.meta.fill ? 'overflow-hidden' : 'overflow-y-auto']"
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
    <SearchSheet />
    <Toaster />
  </div>
</template>
