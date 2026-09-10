<script setup lang="ts">
// Breadcrumb strip — its own header layer, stuck right below the topbar.
// Document routes get the tree ancestry; other routes get their section label.
import { computed, onMounted, watch } from 'vue'
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

interface Crumb { label: string; to?: string }

// Route -> message key, translated at render: a crumb must follow the language
// the way every other label does (docs/features/18).
const STATIC: Record<string, string> = {
  '/search': 'nav.search',
  '/merge-requests': 'nav.mergeRequests',
  '/workflows': 'nav.workflows',
}

const SETTINGS: Record<string, string> = {
  '/settings/profile': 'nav.profile',
  '/settings/projects': 'nav.projects',
  '/settings/users': 'nav.users',
  '/settings/access': 'nav.access',
  '/settings/activity': 'nav.activity',
  '/settings/ai': 'nav.ai',
  '/settings/glossary': 'nav.glossary',
  '/settings/workflows': 'nav.workflows',
  '/settings/connectors': 'nav.connectors',
  '/settings/docs': 'nav.docs',
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
  // A project's own page (docs/features/24). Leads with the roster, then the
  // project — the same two-step trail /settings/projects/:id makes, pointed at
  // the read side rather than the form.
  if (path.startsWith('/projects/')) {
    const id = route.params.id as string
    const name = projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
    return [{ label: t('nav.projects'), to: '/settings/projects' }, { label: name }]
  }
  if (path.startsWith('/merge-requests/')) {
    return [
      { label: t('nav.mergeRequests'), to: '/merge-requests' },
      { label: (route.params.id as string).slice(0, 8) },
    ]
  }
  if (path.startsWith('/settings')) {
    // Docs stop at the section rather than naming the article. Resolving the
    // title would mean importing the docs registry — whose eager glob holds
    // every article body — into the layout, so the whole manual would ship in
    // the main chunk to label one crumb the <h1> below already carries.
    if (path.startsWith('/settings/docs/')) {
      return [{ label: t('nav.settings'), to: '/settings' }, { label: t('nav.docs'), to: '/settings/docs' }]
    }
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
  // Both /u and /u/:userId. Neutral on purpose: the page's own header names
  // the person, and a crumb reading "Your profile" over a colleague's page
  // would be a lie the header then contradicts.
  if (path === '/u' || path.startsWith('/u/')) return [{ label: t('nav.profile') }]
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
