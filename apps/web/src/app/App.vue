<script setup lang="ts">
import { onMounted, provide, ref, watch, watchEffect } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import { Library } from 'lucide-vue-next'
import { useQueryClient } from '@tanstack/vue-query'
import { Toaster } from '@/shared/ui/sonner'
import { ConfirmDialog } from '@/shared/ui/confirm'
import AppShell from '@/app/shell/AppShell.vue'
import { useAuthStore } from '@/stores/auth'
import { useEventsStore } from '@/stores/events'
import { useLayoutStore } from '@/stores/layout'
import { RAIL_MEMORY } from '@/shared/layout'
import { useSearchUiStore } from '@/modules/documents'
import { startLive } from '@/shared/api'
import { startPwa } from '@/shared/utils/pwa'
import { authSlideDirection } from '@/app/router'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const auth = useAuthStore()
const events = useEventsStore()
const searchUi = useSearchUiStore()
// The page rail's remembered open state (shared/layout cannot import a store).
provide(RAIL_MEMORY, useLayoutStore())

// A workspace switch from inside the search sheet reloads the app; pick the
// query back up on the other side.
onMounted(() => searchUi.hydrateFromSession())
// The service worker, its update toast and the offline notice (#472).
onMounted(() => startPwa(t))
const route = useRoute()
const queryClient = useQueryClient()

// Feature 04: one SSE connection per session — only once authenticated
// (the events endpoint needs a ?token= ticket in AUTH_MODE=api-key). The live
// WebSocket (tracked-entity updates → query-cache patching) starts alongside.
watchEffect(() => {
  // A gated account (unconfirmed address under AUTH_REQUIRE_VERIFIED_EMAIL)
  // would only collect 403s and a refused socket.
  if (!import.meta.env.SSR && auth.authenticated && !auth.verificationPending) {
    events.connect(t)
    startLive({ queryClient })
  }
})

/**
 * Which way the signed-out card slides. Resolved in a `pre`-flush watcher so it
 * is already correct when the swap it describes begins to render.
 */
const authDir = ref<'fwd' | 'back'>('fwd')
watch(
  () => route.path,
  (to, from) => {
    authDir.value = authSlideDirection(to, from)
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
      <span class="font-display text-base font-bold tracking-tight">Knowledge</span>
    </div>
    <!-- Pane 1 for the signed-out shell, exactly as in the app shell. Only one
         of the two is ever mounted, so the level is never ambiguous; the router
         re-applies the name after the DOM settles, which is what lets a
         login-to-app navigation cross between the two. -->
    <main data-kn-pane="1" class="flex flex-1 flex-col items-center justify-center px-4 py-6 sm:py-10">
      <!-- The auth cards slide laterally between each other. `out-in` because
           the two carry different forms: overlapping them would put two sets of
           labels on top of each other at different offsets. -->
      <RouterView v-slot="{ Component }">
        <Transition :name="`kn-auth-${authDir}`" mode="out-in">
          <component :is="Component" />
        </Transition>
      </RouterView>
    </main>
    <Toaster />
  </div>

  <AppShell v-else />
  <!-- Once, for both shells: every `confirm()` draws here. -->
  <ConfirmDialog />
</template>
