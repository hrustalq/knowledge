<script setup lang="ts">
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'
</script>

<template>
  <div class="space-y-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">Activity</h1>
      <p class="mt-1 text-sm text-muted-foreground">Everything that happened in this workspace, live.</p>
    </div>
    <ActivityFeed />
  </div>
</template>
