<script setup lang="ts">
// The newest-revised pages the caller may open (#1243), the project page's list workspace-wide.
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import { FileText } from 'lucide-vue-next'
import type { HomeRecentPage } from '@knowledge/contracts'
import { relativeTime } from '@/shared/api/api'
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
    <li v-for="page in pages" :key="page.documentId" class="flex items-center gap-2 px-4 py-2.5 text-sm">
      <FileText class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <RouterLink :to="`/documents/${page.documentId}`" class="-my-1 min-w-0 flex-1 truncate py-1 font-medium hover:underline outline-none focus-visible:ring-3 focus-visible:ring-ring rounded-sm">
        {{ page.title }}
      </RouterLink>
      <span class="shrink-0 text-xs text-muted-foreground">{{ relativeTime(page.updatedAt) }}</span>
    </li>
  </ul>
</template>
