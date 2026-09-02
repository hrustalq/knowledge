<script setup lang="ts">
import { onMounted } from 'vue'
import { RouterLink, RouterView } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
import { useEventsStore } from '@/stores/events'

// Feature 04: one SSE connection per session for live updates.
const events = useEventsStore()
onMounted(() => events.connect())
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b">
      <nav class="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
        <RouterLink to="/documents" class="font-semibold">Knowledge</RouterLink>
        <RouterLink to="/documents" class="text-sm text-muted-foreground hover:text-foreground">Documents</RouterLink>
        <RouterLink to="/search" class="text-sm text-muted-foreground hover:text-foreground">Search</RouterLink>
        <RouterLink to="/activity" class="text-sm text-muted-foreground hover:text-foreground">Activity</RouterLink>
        <RouterLink to="/create" class="ml-auto text-sm text-muted-foreground hover:text-foreground">+ New</RouterLink>
      </nav>
    </header>
    <main class="mx-auto max-w-5xl px-4 py-6">
      <RouterView />
    </main>
    <Toaster />
  </div>
</template>
