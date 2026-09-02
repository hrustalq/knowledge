<script setup lang="ts">
import { watchEffect } from 'vue'
import { RouterLink, RouterView, useRouter } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import { Button } from '@/components/ui/button'
import { useQueryClient } from '@tanstack/vue-query'
import { useAuthStore } from '@/stores/auth'
import { useEventsStore } from '@/stores/events'
import { startLive } from '@/api'

const auth = useAuthStore()
const events = useEventsStore()
const router = useRouter()
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

async function logout() {
  await auth.logout()
  await router.push('/login')
}
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
        <RouterLink to="/documents" class="font-semibold">Knowledge</RouterLink>
        <template v-if="auth.authenticated">
          <RouterLink to="/documents" class="text-sm text-muted-foreground hover:text-foreground">Documents</RouterLink>
          <RouterLink to="/search" class="text-sm text-muted-foreground hover:text-foreground">Search</RouterLink>
          <RouterLink to="/activity" class="text-sm text-muted-foreground hover:text-foreground">Activity</RouterLink>
          <RouterLink to="/access" class="text-sm text-muted-foreground hover:text-foreground">Access</RouterLink>
          <RouterLink v-if="auth.isAdmin || auth.isDev" to="/admin/users" class="text-sm text-muted-foreground hover:text-foreground">
            Users
          </RouterLink>
          <RouterLink v-if="auth.canEdit" to="/create" class="ml-auto text-sm text-muted-foreground hover:text-foreground">
            + New
          </RouterLink>
          <div class="flex items-center gap-2" :class="{ 'ml-auto': !auth.canEdit }">
            <span class="text-xs text-muted-foreground" :title="auth.me?.email">
              {{ auth.me?.displayName }}<template v-if="auth.role"> · {{ auth.role }}</template>
            </span>
            <Button v-if="!auth.isDev" size="sm" variant="ghost" @click="logout">Log out</Button>
          </div>
        </template>
        <RouterLink v-else to="/login" class="ml-auto text-sm text-muted-foreground hover:text-foreground">
          Log in
        </RouterLink>
      </nav>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <RouterView />
    </main>
    <Toaster />
  </div>
</template>
