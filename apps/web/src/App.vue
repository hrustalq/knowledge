<script setup lang="ts">
import { onMounted, ref, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { Library } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import { Toaster } from '@/components/ui/sonner'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import AppBreadcrumbs from '@/components/layout/AppBreadcrumbs.vue'
import SearchSheet from '@/components/knowledge/SearchSheet.vue'
import { useAuthStore } from '@/stores/auth'
import { useEventsStore } from '@/stores/events'
import { useSearchUiStore } from '@/stores/search-ui'
import { useSidebarStore } from '@/stores/sidebar'
import { startLive } from '@/api'

const auth = useAuthStore()
const events = useEventsStore()
const searchUi = useSearchUiStore()
const sidebar = useSidebarStore()

// A workspace switch from inside the search sheet reloads the app; pick the
// query back up on the other side.
onMounted(() => searchUi.hydrateFromSession())
const route = useRoute()
const queryClient = useQueryClient()

// Feature 04: one SSE connection per session — only once authenticated
// (the events endpoint needs the ?token= in AUTH_MODE=api-key). The live
// WebSocket (tracked-entity updates → query-cache patching) starts alongside.
watchEffect(() => {
  if (!import.meta.env.SSR && auth.authenticated) {
    events.connect()
    startLive({ queryClient })
  }
})

/**
 * Desktop: collapsible rail; mobile: off-canvas drawer. The desktop half of
 * that lives in the sidebar store because its width and open state are drawn
 * by the server on the first frame — see lib/api's rail accessors.
 */
const mobileOpen = ref(false)
function toggleSidebar() {
  if (window.matchMedia('(min-width: 1024px)').matches) sidebar.toggle()
  else mobileOpen.value = !mobileOpen.value
}
watch(
  () => route.fullPath,
  () => {
    mobileOpen.value = false
  },
)
</script>

<template>
  <!-- Public / signed-out screens: quiet centered layout, no app chrome -->
  <div
    v-if="route.meta.public || !auth.authenticated"
    class="flex min-h-screen flex-col bg-background text-foreground"
  >
    <div class="flex items-center gap-2 px-6 py-5">
      <span class="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
        <Library class="size-4" />
      </span>
      <span class="font-display text-[15px] font-bold tracking-tight">Knowledge</span>
    </div>
    <!-- Pane 1 for the signed-out shell, exactly as in the app shell below.
         Only one of the two is ever mounted, so the level is never ambiguous;
         the router re-applies the name after the DOM settles, which is what
         lets a login-to-app navigation cross between the two. -->
    <main data-kn-pane="1" class="flex-1 px-4 pb-10">
      <RouterView />
    </main>
    <Toaster />
  </div>

  <!-- App shell: sidebar + topbar + scrolling content column -->
  <div
    v-else
    class="relative flex h-screen overflow-hidden bg-background text-foreground"
    :class="sidebar.resizing ? 'kn-resizing' : ''"
    :style="{ '--kn-rail-w': sidebar.widthPx }"
    :data-rail-open="sidebar.open"
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
    <div class="kn-rail absolute inset-y-0 left-0 z-20 hidden lg:block" :inert="!sidebar.open || undefined">
      <AppSidebar />
    </div>

    <!-- Mobile drawer: the same rail, arriving as a drawer over a scrim. -->
    <Transition name="drawer" :duration="260">
      <div v-if="mobileOpen" class="fixed inset-0 z-40 lg:hidden">
        <div class="kn-drawer-scrim absolute inset-0 bg-black/40" aria-hidden="true" @click="mobileOpen = false" />
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
      <!-- `meta.bare`: writing surfaces supply their own header, so the app
           trail would just be a second, competing one. -->
      <AppBreadcrumbs v-if="!route.meta.bare" />
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
        <div :class="['flex w-full flex-col', route.meta.fill ? 'h-full' : 'min-h-full px-4 py-6 lg:px-8']">
          <RouterView />
        </div>
      </main>
    </div>
    <SearchSheet />
    <Toaster />
  </div>
</template>
