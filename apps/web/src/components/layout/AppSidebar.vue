<script setup lang="ts">
// Left navigation rail: brand, workspace switcher, primary nav, and the
// Projects → Pages navigation stack (Confluence-style space sidebar).
import { computed, ref, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { GitPullRequestArrow, House, Library, Settings, Sparkles,
  Workflow,
} from 'lucide-vue-next'
import type { ScopeCreated } from '@/lib/scopes'
import ScopeSwitcher from './ScopeSwitcher.vue'
import SidebarPanes from './SidebarPanes.vue'
import SidebarResizeHandle from './SidebarResizeHandle.vue'
import SwitcherCreateDialog from './SwitcherCreateDialog.vue'

const { t } = useI18n()

const route = useRoute()
const router = useRouter()

// The create dialog is owned here because both scope levels open it: the
// workspace row in the switcher above, and the roster's + button below.
const creating = ref<'workspace' | 'project' | null>(null)
const seedName = ref('')

function openCreate(kind: 'workspace' | 'project', query = '') {
  seedName.value = query
  creating.value = kind
}

/**
 * The dialog applies the scope switch itself; where to land afterwards is the
 * caller's business. From the rail, a new project means "show me its pages" —
 * a new workspace reloads the app, so there is nothing to route.
 */
function onCreated(created: ScopeCreated) {
  if (created.kind === 'project') void router.push('/documents')
}

interface NavLink { to: string; label: string; icon: Component }
const links = computed<NavLink[]>(() => [
  { to: '/documents', label: t('nav.home'), icon: House },
  // Search is not a destination — it is the topbar trigger's sheet ("/" or ⌘K).
  { to: '/merge-requests', label: t('nav.mergeRequests'), icon: GitPullRequestArrow },
  { to: '/workflows', label: t('nav.workflows'), icon: Workflow },
  { to: '/assistant', label: t('nav.assistant'), icon: Sparkles },
  // Projects, users, access and activity live under the settings shell.
  { to: '/settings', label: t('nav.settings'), icon: Settings },
])

function isCurrent(to: string): boolean {
  return to === '/documents' ? route.path === '/documents' : route.path.startsWith(to)
}
</script>

<template>
  <!-- Width comes from the shell (`--kn-rail-w`), not from here: the rail, the
       spacer that closes beside it and the drawer that borrows it all have to
       agree on one number, and the store is where that number is clamped. -->
  <aside class="border-sidebar-border bg-sidebar text-sidebar-foreground relative flex h-full w-full shrink-0 flex-col border-r">
    <div class="pt-4 pb-3">
      <RouterLink to="/documents" class="flex items-center gap-2 px-4">
        <span class="bg-primary text-primary-foreground grid size-7 shrink-0 place-items-center rounded-md">
          <Library class="size-4" />
        </span>
        <span class="font-display text-[15px] font-bold tracking-tight">{{ t('nav.brand') }}</span>
      </RouterLink>
      <ScopeSwitcher @create="openCreate" />
    </div>

    <nav class="space-y-px px-2" :aria-label="t('nav.primary')">
      <RouterLink
        v-for="l in links"
        :key="l.to"
        :to="l.to"
        class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        :class="isCurrent(l.to)
          ? 'bg-primary/10 font-medium text-primary'
          : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'"
      >
        <component :is="l.icon" class="size-4 shrink-0" />
        {{ l.label }}
      </RouterLink>
    </nav>

    <SidebarPanes @create="openCreate('project')" />

    <SidebarResizeHandle />

    <SwitcherCreateDialog
      :kind="creating"
      :initial-name="seedName"
      @update:kind="creating = $event"
      @created="onCreated"
    />
  </aside>
</template>
