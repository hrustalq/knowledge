<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router'
import { Toaster } from '@/components/ui/sonner'
</script>

<template>
  <div class="min-h-screen bg-background text-foreground">
    <header class="border-b">
      <nav class="mx-auto flex max-w-4xl items-center gap-6 px-4 py-3">
        <RouterLink to="/documents" class="font-semibold">Knowledge</RouterLink>
        <RouterLink to="/documents" class="text-sm text-muted-foreground hover:text-foreground">Documents</RouterLink>
        <RouterLink to="/search" class="text-sm text-muted-foreground hover:text-foreground">Search</RouterLink>
        <RouterLink to="/upload" class="text-sm text-muted-foreground hover:text-foreground">Upload</RouterLink>
      </nav>
    </header>
    <main class="mx-auto max-w-4xl px-4 py-6">
      <RouterView />
    </main>
    <Toaster />
  </div>
</template>
