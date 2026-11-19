<script setup lang="ts">
// The newest-revised pages the caller may open (#1243), the project page's list workspace-wide.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import type { HomeRecentPage } from '@knowledge/contracts'
import { RecentPageRow } from '@/entities/document'
import { usePermission } from '@/stores/permissions'

defineProps<{ pages: HomeRecentPage[] }>()
const { t } = useI18n()
const canContribute = usePermission('workspace:contribute')
</script>

<template>
  <p v-if="pages.length === 0" class="rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground">
    {{ t('home.recent.empty') }}
    <RouterLink v-if="canContribute" to="/create" class="text-primary underline underline-offset-2">
      {{ t('home.recent.create') }}
    </RouterLink>
  </p>
  <ul v-else class="divide-y rounded-xl border bg-card">
    <RecentPageRow v-for="page in pages" :key="page.documentId" :page="page" />
  </ul>
</template>
