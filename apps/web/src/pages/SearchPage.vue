<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import SearchWidget from '@/components/knowledge/SearchWidget.vue'

const route = useRoute()
const q = computed(() => (typeof route.query.q === 'string' ? route.query.q : undefined))
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">Search</h1>
      <p class="mt-1 text-sm text-muted-foreground">
        Semantic, keyword and graph-expanded search across the workspace.
      </p>
    </div>
    <SearchWidget :key="q ?? ''" :initial-query="q" class="min-h-0 flex-1" />
  </div>
</template>
