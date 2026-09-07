<script setup lang="ts">
// Settings shell: nested pages (projects / users / access / activity) rendered
// in the content column, with their own nav rail flush against the left edge.
import { computed, type Component } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { Activity, FolderKanban, ShieldCheck, Users } from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const route = useRoute()

interface SettingsLink { to: string; label: string; icon: Component; hint: string }
const links = computed<SettingsLink[]>(() => [
  { to: '/settings/projects', label: 'Projects', icon: FolderKanban, hint: 'Organize documents' },
  ...(auth.isAdmin || auth.isDev
    ? [{ to: '/settings/users', label: 'Users', icon: Users, hint: 'Platform accounts' }]
    : []),
  { to: '/settings/access', label: 'Access', icon: ShieldCheck, hint: 'Workspace members' },
  { to: '/settings/activity', label: 'Activity', icon: Activity, hint: 'Workspace timeline' },
])
</script>

<template>
  <!-- Bleed out of the main column's padding so the rail sits flush -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row lg:items-stretch">
    <!-- Sticky rail: the content column scrolls (inside <main>), the nav doesn't.
         100vh minus the topbar (h-14) and breadcrumb strip (h-9) = the scrollport. -->
    <nav
      aria-label="Settings"
      class="sticky top-0 z-10 shrink-0 border-b bg-background p-0 lg:h-[calc(100vh-5.75rem)] lg:w-56 lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r"
    >
      <ul class="flex gap-1 overflow-x-auto px-2 py-2 lg:block lg:space-y-px lg:overflow-visible lg:p-0">
        <li v-for="l in links" :key="l.to">
          <RouterLink
            :to="l.to"
            class="flex items-center gap-2.5 px-3 py-2 text-sm transition-colors lg:rounded-none"
            :class="route.path.startsWith(l.to)
              ? 'bg-primary/10 font-medium text-primary'
              : 'text-foreground/80 hover:bg-accent hover:text-foreground'"
          >
            <component :is="l.icon" class="size-4 shrink-0" />
            <span class="min-w-0">
              <span class="block truncate">{{ l.label }}</span>
              <span class="hidden truncate text-[11px] text-muted-foreground lg:block">{{ l.hint }}</span>
            </span>
          </RouterLink>
        </li>
      </ul>
    </nav>

    <div class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <RouterView />
    </div>
  </div>
</template>
