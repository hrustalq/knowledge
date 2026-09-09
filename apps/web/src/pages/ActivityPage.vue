<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import ActivityFeed from '@/components/knowledge/ActivityFeed.vue'

const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-5">
    <div>
      <h1 class="font-display text-2xl font-bold tracking-tight">{{ t('activity.title') }}</h1>
      <p class="mt-1 text-sm text-muted-foreground">{{ t('activity.subtitle') }}</p>
    </div>
    <!-- Fill the viewport: the feed owns the scroll (virtualized), not the page. -->
    <ActivityFeed height="calc(100vh - 15rem)" class="min-h-0 flex-1" />
  </div>
</template>
