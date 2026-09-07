<script setup lang="ts">
// Breadcrumb strip — its own header layer, stuck right below the topbar.
// Document routes get the tree ancestry; other routes get their section label.
import { computed, onMounted } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'

const route = useRoute()
const store = useDocumentsStore()
const projects = useProjectsStore()

// The sidebar may be collapsed (and unmounted), so make sure the tree loads.
onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
})

interface Crumb { label: string; to?: string }

const STATIC: Record<string, string> = {
  '/search': 'Search',
  '/merge-requests': 'Merge requests',
}

const SETTINGS: Record<string, string> = {
  '/settings/projects': 'Projects',
  '/settings/users': 'Users',
  '/settings/access': 'Access',
  '/settings/activity': 'Activity',
}

/** Pages live inside a project, so page trails lead with the active project. */
function pageRoot(): Crumb[] {
  const name = projects.activeName
  return name ? [{ label: name, to: '/settings/projects' }, { label: 'Pages', to: '/documents' }] : [{ label: 'Pages', to: '/documents' }]
}

const crumbs = computed<Crumb[]>(() => {
  const path = route.path
  if (path === '/documents') return pageRoot()
  if (path.startsWith('/documents/')) {
    const id = route.params.id as string
    const trail = store.pathTo(id)
    const list: Crumb[] = pageRoot()
    for (const node of trail) list.push({ label: node.title, to: `/documents/${node.documentId}` })
    if (path.endsWith('/edit')) list.push({ label: 'Edit' })
    return list
  }
  if (path.startsWith('/merge-requests/')) {
    return [
      { label: 'Merge requests', to: '/merge-requests' },
      { label: (route.params.id as string).slice(0, 8) },
    ]
  }
  if (path.startsWith('/settings')) {
    if (path.startsWith('/settings/projects/')) {
      const id = route.params.id as string
      const name = projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
      return [{ label: 'Settings', to: '/settings' }, { label: 'Projects', to: '/settings/projects' }, { label: name }]
    }
    const label = SETTINGS[path]
    return label ? [{ label: 'Settings', to: '/settings' }, { label }] : [{ label: 'Settings' }]
  }
  if (path === '/create') return [...pageRoot(), { label: 'New page' }]
  if (path === '/upload') return [...pageRoot(), { label: 'Upload' }]
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
