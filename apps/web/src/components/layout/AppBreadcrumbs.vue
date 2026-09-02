<script setup lang="ts">
// Breadcrumb strip — its own header layer, stuck right below the topbar.
// Document routes get the tree ancestry; other routes get their section label.
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'

const route = useRoute()
const store = useDocumentsStore()

// The sidebar may be collapsed (and unmounted), so make sure the tree loads.
onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
})

interface Crumb { label: string; to?: string }

const STATIC: Record<string, string> = {
  '/search': 'Search',
  '/activity': 'Activity',
  '/access': 'Access',
  '/admin/users': 'Users',
}

const crumbs = computed<Crumb[]>(() => {
  const path = route.path
  if (path === '/documents') return [{ label: 'Pages' }]
  if (path.startsWith('/documents/')) {
    const id = route.params.id as string
    const trail = store.pathTo(id)
    const list: Crumb[] = [{ label: 'Pages', to: '/documents' }]
    for (const node of trail) list.push({ label: node.title, to: `/documents/${node.documentId}` })
    if (path.endsWith('/edit')) list.push({ label: 'Edit' })
    return list
  }
  if (path === '/create') return [{ label: 'Pages', to: '/documents' }, { label: 'New page' }]
  if (path === '/upload') return [{ label: 'Pages', to: '/documents' }, { label: 'Upload' }]
  const label = STATIC[path]
  return label ? [{ label }] : []
})
</script>

<template>
  <nav
    v-if="crumbs.length > 0"
    aria-label="Breadcrumb"
    class="sticky top-14 z-20 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b bg-background/90 px-4 text-xs text-muted-foreground backdrop-blur lg:px-8"
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
