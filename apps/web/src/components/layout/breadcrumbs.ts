import { computed, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { useDocumentsStore } from '@/stores/documents'
import { useProjectsStore } from '@/stores/projects'
import { useWorkflowsStore } from '@/stores/workflows'

/**
 * The breadcrumb trail, as a value rather than as markup.
 *
 * It was computed inside AppBreadcrumbs, which was fine while the strip was the
 * only thing that needed it. It is not: the strip renders conditionally
 * (`v-if="crumbs.length > 0"`), so its height is part of how tall the shell's
 * chrome is, and the shell has to know that number to publish `--kn-chrome-h`
 * for the sub-rails below it. Five places used to hardcode the answer as
 * `5.75rem` — topbar plus strip — and every one of them was wrong on a route
 * with no trail.
 *
 * Deliberately free of side effects. AppBreadcrumbs still does its own
 * `onMounted` fetching; this only reads what the stores already hold, so the
 * shell can call it without a second component triggering a second load.
 */
export interface Crumb {
  label: string
  to?: string
}

// Route -> message key, translated at render: a crumb must follow the language
// the way every other label does (docs/features/18).
/*
 * Top-level destinations that are one step deep and name themselves.
 *
 * A route missing from here gets no trail at all, and two were: the assistant
 * and the notification inbox both rendered with the strip absent, so the page
 * began under the topbar while every neighbouring route began under a trail —
 * the chrome changed height as you moved between them. Being one level deep is
 * not a reason to have no crumb; it is the reason the crumb is one item.
 */
const STATIC: Record<string, string> = {
  '/search': 'nav.search',
  '/merge-requests': 'nav.mergeRequests',
  '/workflows': 'nav.workflows',
  '/assistant': 'nav.assistant',
  '/notifications': 'nav.notifications',
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

export function useCrumbs(): ComputedRef<Crumb[]> {
  const { t } = useI18n()
  const route = useRoute()
  const store = useDocumentsStore()
  const projects = useProjectsStore()
  const workflows = useWorkflowsStore()

  /** Pages live inside a project, so page trails lead with the active project. */
  function pageRoot(): Crumb[] {
    const name = projects.activeName
    return name
      ? [{ label: name, to: '/settings/projects' }, { label: t('nav.pages'), to: '/documents' }]
      : [{ label: t('nav.pages'), to: '/documents' }]
  }

  return computed<Crumb[]>(() => {
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
        return [
          { label: t('nav.settings'), to: '/settings' },
          { label: t('nav.docs'), to: '/settings/docs' },
        ]
      }
      if (path.startsWith('/settings/projects/')) {
        const id = route.params.id as string
        const name = projects.items.find((p) => p.projectId === id)?.name ?? id.slice(0, 8)
        return [
          { label: t('nav.settings'), to: '/settings' },
          { label: t('nav.projects'), to: '/settings/projects' },
          { label: name },
        ]
      }
      // The workflow builder is the third pane of the settings shell, so it takes
      // the same three-step trail as a project. `/new` is the wizard, which is
      // `meta.bare` and never reaches here.
      if (path.startsWith('/settings/workflows/')) {
        const id = route.params.id as string
        const name = workflows.byId(id)?.name ?? id.slice(0, 8)
        const list: Crumb[] = [
          { label: t('nav.settings'), to: '/settings' },
          { label: t('nav.workflows'), to: '/settings/workflows' },
          { label: name, to: `/settings/workflows/${id}` },
        ]
        // Editing is its own route, so it is its own crumb — and the workflow's
        // name above it becomes the way back to reading it, exactly as a page's
        // does under /documents/:id/edit.
        if (path.endsWith('/edit')) list.push({ label: t('nav.edit') })
        return list
      }
      // One connector (docs/features/32). The name is not in any store — a
      // connector roster is workspace-wide and loaded by the page itself — so
      // the id's prefix stands in until the page's own <h1> names it, which is
      // the same trade the project crumb makes when its roster has not loaded.
      if (path.startsWith('/settings/connectors/')) {
        const list: Crumb[] = [
          { label: t('nav.settings'), to: '/settings' },
          { label: t('nav.connectors'), to: '/settings/connectors' },
        ]
        // A sync run is a third level under the connector, but it arrives by
        // its own id and knows nothing of which connector it belongs to, so it
        // stops at a neutral crumb rather than guessing a parent.
        const id = route.params.id as string | undefined
        if (id) list.push({ label: id.slice(0, 8) })
        else list.push({ label: t('connectors.tabRuns') })
        return list
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
    if (path.startsWith('/workflows/')) {
      return [{ label: t('nav.workflows'), to: '/workflows' }, { label: t('nav.run') }]
    }
    if (path === '/create') return [...pageRoot(), { label: t('nav.newPage') }]
    if (path === '/upload' || path === '/import') return [...pageRoot(), { label: t('nav.import') }]
    const key = STATIC[path]
    return key ? [{ label: t(key) }] : []
  })
}
