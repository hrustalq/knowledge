<script setup lang="ts">
// Breadcrumb strip — its own header layer, stuck right below the topbar.
// Document routes get the tree ancestry; other routes get their section label.
//
// The trail itself is computed in breadcrumbs.ts and handed down, because the
// shell also needs it: whether this strip renders at all is part of how tall
// the chrome above <main> is, and the sub-rails below size themselves against
// that. What stays here is the rendering and the fetching that fills the trail
// in — the composable is deliberately free of side effects so the shell can
// read it without triggering a second load.
import { onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useWorkflowsStore } from '@/stores/workflows'
import type { Crumb } from './breadcrumbs'

defineProps<{ crumbs: Crumb[] }>()

const { t } = useI18n()

const route = useRoute()
const store = useDocumentsStore()
const projects = useProjectsStore()
const workflows = useWorkflowsStore()

// The sidebar may be collapsed (and unmounted), so make sure the tree loads.
onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
  // The last crumb on a builder URL is the workflow's name. The store already
  // de-duplicates this against the document rail's Run button, which wants the
  // same roster.
  if (route.path.startsWith('/settings/workflows/')) void workflows.ensureLoaded()
})

/**
 * The tree arrives a level at a time, so a nested page is usually not in it and
 * `pathTo` would answer with nothing. Asking for the trail fills it in, and the
 * crumbs — computed off the tree — follow. The store de-duplicates this against
 * the sidebar, which wants the same trail for the same reason.
 */
watch(
  () => (route.path.startsWith('/documents/') ? (route.params.id as string) : null),
  (id) => {
    if (id) void store.revealPath(id)
  },
  { immediate: true },
)
</script>

<template>
  <nav
    :aria-label="t('nav.breadcrumb')"
    class="sticky top-0 z-20 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background/90 px-4 text-xs text-muted-foreground backdrop-blur lg:px-8"
  >
    <template v-for="(c, i) in crumbs" :key="i">
      <ChevronRight v-if="i > 0" class="size-3 shrink-0" aria-hidden="true" />
      <RouterLink
        v-if="c.to && i < crumbs.length - 1"
        :to="c.to"
        class="max-w-56 truncate transition-colors hover:text-foreground"
      >
        {{ c.label }}
      </RouterLink>
      <span v-else class="max-w-56 truncate font-medium text-foreground" aria-current="page">{{ c.label }}</span>
    </template>
  </nav>
</template>
