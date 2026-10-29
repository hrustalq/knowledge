<script setup lang="ts">
// Left navigation rail: brand, workspace switcher, primary nav, and the
// Projects → Pages navigation stack (Confluence-style space sidebar).
import { computed, ref, watch, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import {
  AudioLines,
  BookMarked,
  BookmarkPlus,
  ChartColumn,
  ChevronRight,
  FlaskConical,
  GitPullRequestArrow,
  HeartPulse,
  House,
  Library,
  Scale,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-vue-next'
import { SwitcherCreateDialog, type ScopeCreated } from '@/modules/projects'
import { Collapse } from '@/shared/ui/collapse'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { useLayoutStore } from '@/stores/layout'
import type { WorkspaceFeature } from '@knowledge/contracts'
import ScopeSwitcher from './ScopeSwitcher.vue'
import SidebarPanes from './SidebarPanes.vue'
import SidebarResizeHandle from './SidebarResizeHandle.vue'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()

const route = useRoute()
const router = useRouter()

// The create dialog is owned here because both scope levels open it: the
// workspace row in the switcher above, and the roster's + button below.
const creating = ref<'workspace' | 'project' | null>(null)
const seedName = ref('')

// Loaded on first open and kept after, so closing still animates: its steps,
// pickers and member search are not what a first load needs (#279).
const createMounted = ref(false)
watch(creating, (kind) => {
  if (kind) createMounted.value = true
})

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

interface NavLink { to: string; label: string; icon: Component; feature?: WorkspaceFeature }
/** A link to a section the workspace switched off (#604) is not drawn. */
const shown = (list: NavLink[]) => list.filter((l) => !l.feature || features.isOn(l.feature))

const links = computed<NavLink[]>(() => shown([
  { to: '/documents', label: t('nav.home'), icon: House },
  // Search is not a destination — it is the topbar trigger's sheet ("/" or ⌘K).
  { to: '/merge-requests', label: t('nav.mergeRequests'), icon: GitPullRequestArrow },
  { to: '/workflows', label: t('nav.workflows'), icon: Workflow, feature: 'workflows' },
  // Which operations are ready to test (#483).
  { to: '/qa', label: t('nav.qa'), icon: FlaskConical, feature: 'qa' },
  // Recordings of your own (#551): proposals you then review.
  { to: '/memos', label: t('nav.memos'), icon: AudioLines, feature: 'memos' },
  { to: '/assistant', label: t('nav.assistant'), icon: Sparkles, feature: 'assistant' },
]))

// The surfaces that look after the knowledge base as a whole rather than one
// page (#605), folded under one node so the rail stays short.
const knowledgeLinks = computed<NavLink[]>(() => shown([
  // The trust loop's review surface (docs/features/40).
  { to: '/knowledge-health', label: t('nav.knowledgeHealth'), icon: HeartPulse, feature: 'knowledge-health' },
  // Usage analytics (#79): admins only — it carries what people searched for.
  ...(auth.canAdminWorkspace ? [{ to: '/analytics', label: t('nav.analytics'), icon: ChartColumn, feature: 'analytics' as const }] : []),
  // What agents proposed from their sessions (issue #73): page captures are
  // decided on merge requests, but terms and stranded captures only here.
  { to: '/captures', label: t('nav.captures'), icon: BookmarkPlus, feature: 'captures' },
  // Contradictions the arbiter found between pages (#81).
  { to: '/conflicts', label: t('nav.conflicts'), icon: Scale, feature: 'conflicts' },
]))

const CURRENT = 'bg-primary/10 font-medium text-primary'
const IDLE = 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'

function isCurrent(to: string): boolean {
  return to === '/documents' ? route.path === '/documents' : route.path.startsWith(to)
}

// Closed until you open it or land on one of its pages, then kept for the
// session (the layout store is serialized with SSR, so both sides agree).
const layout = useLayoutStore()
const inKnowledge = computed(() => knowledgeLinks.value.some((l) => isCurrent(l.to)))
const knowledgeOpen = computed(() => layout.isSubRailOpen('nav.knowledge', false))
watch(inKnowledge, (inside) => {
  if (inside) layout.setSubRailOpen('nav.knowledge', true)
}, { immediate: true })
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
        <span class="font-display text-base font-bold tracking-tight">{{ t('nav.brand') }}</span>
      </RouterLink>
      <ScopeSwitcher @create="openCreate" />
    </div>

    <nav class="space-y-px px-2" :aria-label="t('nav.primary')">
      <RouterLink
        v-for="l in links"
        :key="l.to"
        :to="l.to"
        class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        :class="isCurrent(l.to) ? CURRENT : IDLE"
      >
        <component :is="l.icon" class="size-4 shrink-0" />
        {{ l.label }}
      </RouterLink>

      <template v-if="knowledgeLinks.length">
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
          :class="inKnowledge && !knowledgeOpen ? CURRENT : IDLE"
          :aria-expanded="knowledgeOpen"
          @click="layout.setSubRailOpen('nav.knowledge', !knowledgeOpen)"
        >
          <BookMarked class="size-4 shrink-0" />
          <span class="min-w-0 flex-1 truncate">{{ t('nav.knowledgeBase') }}</span>
          <ChevronRight
            class="text-muted-foreground size-3.5 shrink-0 transition-transform motion-reduce:transition-none"
            :class="knowledgeOpen ? 'rotate-90' : ''"
            aria-hidden="true"
          />
        </button>
        <Collapse :open="knowledgeOpen">
          <div class="space-y-px pt-px">
            <RouterLink
              v-for="l in knowledgeLinks"
              :key="l.to"
              :to="l.to"
              class="flex items-center gap-2.5 rounded-md py-1.5 pr-2.5 pl-7 text-sm transition-colors"
              :class="isCurrent(l.to) ? CURRENT : IDLE"
            >
              <component :is="l.icon" class="size-4 shrink-0" />
              {{ l.label }}
            </RouterLink>
          </div>
        </Collapse>
      </template>

      <!-- Projects, users, access and activity live under the settings shell. -->
      <RouterLink
        to="/settings"
        class="flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors"
        :class="isCurrent('/settings') ? CURRENT : IDLE"
      >
        <Settings class="size-4 shrink-0" />
        {{ t('nav.settings') }}
      </RouterLink>
    </nav>

    <SidebarPanes @create="openCreate('project')" />

    <SidebarResizeHandle />

    <SwitcherCreateDialog
      v-if="createMounted"
      :kind="creating"
      :initial-name="seedName"
      @update:kind="creating = $event"
      @created="onCreated"
    />
  </aside>
</template>
