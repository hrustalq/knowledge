<script setup lang="ts">
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">Activity</h1>
      <p class="mt-1 text-sm text-muted-foreground">Everything that happened in this workspace, live.</p>
    </div>
    <!-- Fill the viewport: the feed owns the scroll (virtualized), not the page. -->
    <ActivityFeed height="calc(100vh - 15rem)" class="min-h-0 flex-1" />
  </div>
</template>
