<script setup lang="ts">
import { ref, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { Library } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import { Toaster } from '@/components/ui/sonner'
import AppSidebar from '@/components/layout/AppSidebar.vue'
import AppTopbar from '@/components/layout/AppTopbar.vue'
import AppBreadcrumbs from '@/components/layout/AppBreadcrumbs.vue'
import { useAuthStore } from '@/stores/auth'
import { useEventsStore } from '@/stores/events'
import { startLive } from '@/api'

const auth = useAuthStore()
const events = useEventsStore()
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

/** Desktop: collapsible rail; mobile: off-canvas drawer. */
const sidebarOpen = ref(true)
const mobileOpen = ref(false)
function toggleSidebar() {
  if (window.matchMedia('(min-width: 1024px)').matches) sidebarOpen.value = !sidebarOpen.value
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
    <main class="flex-1 px-4 pb-10">
      <RouterView />
    </main>
    <Toaster />
  </div>

  <!-- App shell: sidebar + topbar + scrolling content column -->
  <div v-else class="flex h-screen overflow-hidden bg-background text-foreground">
    <div v-if="sidebarOpen" class="hidden h-full lg:block">
      <AppSidebar />
    </div>

    <!-- Mobile drawer -->
    <div v-if="mobileOpen" class="fixed inset-0 z-40 lg:hidden">
      <div class="absolute inset-0 bg-black/40" aria-hidden="true" @click="mobileOpen = false" />
      <div class="absolute inset-y-0 left-0 h-full shadow-xl">
        <AppSidebar />
      </div>
    </div>

    <div class="flex min-w-0 flex-1 flex-col">
      <AppTopbar @toggle-sidebar="toggleSidebar" />
      <AppBreadcrumbs />
      <main class="flex-1 overflow-y-auto">
        <div class="w-full px-4 py-6 lg:px-8">
          <RouterView />
        </div>
      </main>
    </div>
    <Toaster />
  </div>
</template>
