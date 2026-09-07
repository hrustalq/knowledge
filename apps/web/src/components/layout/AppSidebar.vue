<script setup lang="ts">
// Left navigation rail: brand, workspace + project switchers, primary nav and
// the live page tree (Confluence-style space sidebar).
import { computed, onMounted, type Component } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { GitPullRequestArrow, House, Library, Plus, Settings, Sparkles, Upload } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'
import { useDocumentsStore } from '@/stores/documents'
import { Skeleton } from '@/components/ui/skeleton'
import ScopeSwitcher from './ScopeSwitcher.vue'
import SidebarTreeNode from './SidebarTreeNode.vue'

const auth = useAuthStore()
const store = useDocumentsStore()
const route = useRoute()

onMounted(() => {
  if (!store.treeLoaded) void store.fetchTree()
})

const activeDocId = computed(() =>
  route.path.startsWith('/documents/') ? ((route.params.id as string) ?? null) : null,
)

interface NavLink { to: string; label: string; icon: Component }
const links = computed<NavLink[]>(() => [
  { to: '/documents', label: 'Home', icon: House },
  // Search is not a destination — it is the topbar trigger's sheet ("/" or ⌘K).
  { to: '/merge-requests', label: 'Merge requests', icon: GitPullRequestArrow },
  { to: '/assistant', label: 'Assistant', icon: Sparkles },
  // Projects, users, access and activity live under the settings shell.
  { to: '/settings', label: 'Settings', icon: Settings },
])

function isCurrent(to: string): boolean {
  return to === '/documents' ? route.path === '/documents' : route.path.startsWith(to)
}
</script>

<template>
  <aside class="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
    <div class="pt-4 pb-3">
      <RouterLink to="/documents" class="flex items-center gap-2 px-4">
        <span class="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Library class="size-4" />
        </span>
        <span class="font-display text-[15px] font-bold tracking-tight">Knowledge</span>
      </RouterLink>
      <ScopeSwitcher />
    </div>

    <nav class="space-y-px px-2" aria-label="Primary">
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

    <div class="mt-4 flex items-center justify-between px-4">
      <span class="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pages</span>
      <div v-if="auth.canEdit" class="flex gap-0.5">
        <RouterLink
          to="/upload"
          title="Upload markdown"
          class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Upload class="size-3.5" />
        </RouterLink>
        <RouterLink
          to="/create"
          title="New page"
          class="grid size-6 place-items-center rounded text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          <Plus class="size-4" />
        </RouterLink>
      </div>
    </div>

    <div class="sidebar-scroll mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-4">
      <div v-if="!store.treeLoaded" class="space-y-1.5 px-1 pt-1">
        <Skeleton v-for="i in 6" :key="i" class="h-7 w-full" />
      </div>
      <p v-else-if="store.tree.length === 0" class="px-2.5 pt-1 text-xs text-muted-foreground">
        No pages yet<template v-if="auth.canEdit">
          —
          <RouterLink to="/create" class="text-primary hover:underline">create the first one</RouterLink></template>.
      </p>
      <ul v-else class="space-y-px">
        <SidebarTreeNode
          v-for="node in store.tree"
          :key="node.documentId"
          :node="node"
          :depth="0"
          :active-id="activeDocId"
        />
      </ul>
    </div>
  </aside>
</template>
