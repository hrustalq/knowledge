<script setup lang="ts">
// Left navigation rail: brand, workspace switcher, primary nav, and the
// Projects → Pages navigation stack (Confluence-style space sidebar).
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { BookMarked, ChevronRight, Inbox, Library } from 'lucide-vue-next'
import { SwitcherCreateDialog } from '@/modules/projects'
import { Collapse } from '@knowledge/ui/collapse'
import { useAuthStore } from '@/stores/auth'
import { useFeaturesStore } from '@/stores/features'
import { useLayoutStore } from '@/stores/layout'
import ScopeSwitcher from './ScopeSwitcher.vue'
import SidebarPanes from './SidebarPanes.vue'
import SidebarResizeHandle from './SidebarResizeHandle.vue'
import SidebarNavLink from './SidebarNavLink.vue'
import { HOME_NAV, KNOWLEDGE_NAV, NAV_CURRENT, NAV_IDLE, PRIMARY_NAV, SETTINGS_NAV, type NavItem } from './nav'

const { t } = useI18n()
const auth = useAuthStore()
const features = useFeaturesStore()

const route = useRoute()
const router = useRouter()

// The workspace create dialog is owned here; a new project is the
// /projects/new wizard (#716), carrying whatever was typed into the filter.
const creating = ref<'workspace' | null>(null)
const seedName = ref('')

// Loaded on first open and kept after, so closing still animates: its steps,
// pickers and member search are not what a first load needs (#279).
const createMounted = ref(false)
watch(creating, (kind) => {
  if (kind) createMounted.value = true
})

function openCreate(kind: 'workspace' | 'project', query = '') {
  if (kind === 'project') {
    void router.push({ path: '/projects/new', query: query.trim() ? { name: query.trim() } : {} })
    return
  }
  seedName.value = query
  creating.value = kind
}


/** A link to a section the workspace switched off (#604) is not drawn. */
const shown = (list: NavItem[]) =>
  list.filter((l) => (!l.feature || features.isOn(l.feature)) && (!l.workspaceAdmin || auth.canAdminWorkspace))

// A direct workspace's merge requests are proposals from agents and captures (#958): same route, its own name.
const links = computed(() =>
  shown(PRIMARY_NAV).map((l) => (l.to === '/merge-requests' && features.proposalsOnly ? { ...l, labelKey: 'nav.proposals', icon: Inbox } : l)),
)
const knowledgeLinks = computed(() => shown(KNOWLEDGE_NAV))

// Closed until you open it or land on one of its pages, then kept for the
// session (the layout store is serialized with SSR, so both sides agree).
const layout = useLayoutStore()
const inKnowledge = computed(() => knowledgeLinks.value.some((l) => route.path.startsWith(l.to)))
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
      <SidebarNavLink :item="HOME_NAV" />

      <template v-if="knowledgeLinks.length">
        <button
          type="button"
          class="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors"
          :class="inKnowledge && !knowledgeOpen ? NAV_CURRENT : NAV_IDLE"
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
            <SidebarNavLink v-for="l in knowledgeLinks" :key="l.to" :item="l" nested />
          </div>
        </Collapse>
      </template>

      <SidebarNavLink v-for="l in links" :key="l.to" :item="l" />
      <SidebarNavLink :item="SETTINGS_NAV" />
    </nav>

    <SidebarPanes @create="openCreate('project')" />

    <SidebarResizeHandle />

    <SwitcherCreateDialog
      v-if="createMounted"
      :kind="creating"
      :initial-name="seedName"
      @update:kind="creating = $event"
    />
  </aside>
</template>
