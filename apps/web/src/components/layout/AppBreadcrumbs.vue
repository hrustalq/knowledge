<script setup lang="ts">
// Breadcrumb strip — its own header layer, stuck right below the topbar.
// Document routes get the tree ancestry; other routes get their section label.
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { ChevronRight } from 'lucide-vue-next'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'

const { t } = useI18n()

const route = useRoute()
const store = useDocumentsStore()
const projects = useProjectsStore()

// The sidebar may be collapsed (and unmounted), so make sure the tree loads.
onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
  if (!projects.loaded) void projects.fetchList().catch(() => undefined)
})

interface Crumb { label: string; to?: string }

// Route -> message key, translated at render: a crumb must follow the language
// the way every other label does (docs/features/18).
const STATIC: Record<string, string> = {
  '/search': 'nav.search',
  '/merge-requests': 'nav.mergeRequests',
  '/workflows': 'nav.workflows',
}

const SETTINGS: Record<string, string> = {
  '/settings/projects': 'nav.projects',
  '/settings/users': 'nav.users',
  '/settings/access': 'nav.access',
  '/settings/activity': 'nav.activity',
  '/settings/ai': 'nav.ai',
  '/settings/glossary': 'nav.glossary',
  '/settings/workflows': 'nav.workflows',
}

/** Pages live inside a project, so page trails lead with the active project. */
function pageRoot(): Crumb[] {
  const name = projects.activeName
  return name ? [{ label: name, to: '/settings/projects' }, { label: t('nav.pages'), to: '/documents' }] : [{ label: t('nav.pages'), to: '/documents' }]
}

const crumbs = computed<Crumb[]>(() => {
  const path = route.path
  if (path === '/documents') return pageRoot()
  if (path.startsWith('/documents/')) {
    const id = route.params.id as string
    const trail = store.pathTo(id)
    const list: Crumb[] = pageRoot()
    for (const node of trail) list.push({ label: node.title, to: `/documents/${node.documentId}` })
    if (path.endsWith('/edit')) list.push({ label: t('nav.edit') })
    return list
  }
  if (path.startsWith('/merge-requests/')) {
    return [
      { label: t('nav.mergeRequests'), to: '/merge-requests' },
      { label: (route.params.id as string).slice(0, 8) },
    ]
  }
  if (path.startsWith('/settings')) {
    if (path.startsWith('/settings/projects/')) {
      const id = route.params.id as string
      const name = projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
      return [{ label: t('nav.settings'), to: '/settings' }, { label: t('nav.projects'), to: '/settings/projects' }, { label: name }]
    }
    const key = SETTINGS[path]
    return key
      ? [{ label: t('nav.settings'), to: '/settings' }, { label: t(key) }]
      : [{ label: t('nav.settings') }]
  }
  if (path.startsWith('/workflows/')) return [{ label: t('nav.workflows'), to: '/workflows' }, { label: t('nav.run') }]
  if (path === '/create') return [...pageRoot(), { label: t('nav.newPage') }]
  if (path === '/upload' || path === '/import') return [...pageRoot(), { label: t('nav.import') }]
  const key = STATIC[path]
  return key ? [{ label: t(key) }] : []
})
</script>

<template>
  <nav
    v-if="crumbs.length > 0"
    :aria-label="t('nav.breadcrumb')"
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
