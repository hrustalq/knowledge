<script setup lang="ts">
// Settings shell: nested pages (projects / users / access / activity) rendered
// in the content column, with their own nav rail flush against the left edge.
import { useI18n } from 'vue-i18n'
import { computed, type Component } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import {
  Activity,
  Bell,
  BookMarked,
  BookOpen,
  FolderKanban,
  Plug,
  ShieldCheck,
  Sparkles,
  UserRound,
  Users,
  Workflow,
} from 'lucide-vue-next'
import { useAuthStore } from '@/stores/auth'

const { t } = useI18n()

const auth = useAuthStore()
const route = useRoute()

interface SettingsLink { to: string; label: string; icon: Component; hint: string }
const links = computed<SettingsLink[]>(() => [
  // First, and open to every role: the only section that acts on you rather
  // than on the workspace.
  { to: '/settings/profile', label: t('nav.profile'), icon: UserRound, hint: t('settings.profileHint') },
  { to: '/settings/notifications', label: t('nav.notifications'), icon: Bell, hint: t('settings.notificationsHint') },
  { to: '/settings/projects', label: t('nav.projects'), icon: FolderKanban, hint: t('settings.projectsHint') },
  { to: '/settings/glossary', label: t('nav.glossary'), icon: BookMarked, hint: t('settings.glossaryHint') },
  ...(auth.isAdmin || auth.isDev
    ? [{ to: '/settings/users', label: t('nav.users'), icon: Users, hint: t('settings.usersHint') }]
    : []),
  { to: '/settings/access', label: t('nav.access'), icon: ShieldCheck, hint: t('settings.accessHint') },
  { to: '/settings/activity', label: t('nav.activity'), icon: Activity, hint: t('settings.activityHint') },
  { to: '/settings/ai', label: t('nav.ai'), icon: Sparkles, hint: t('settings.aiHint') },
  { to: '/settings/workflows', label: t('nav.workflows'), icon: Workflow, hint: t('settings.workflowsHint') },
  { to: '/settings/connectors', label: t('nav.connectors'), icon: Plug, hint: t('settings.connectorsHint') },
  // Last, and open to every role: it is the section you go to when one of the
  // others did not explain itself.
  { to: '/settings/docs', label: t('nav.docs'), icon: BookOpen, hint: t('settings.docsHint') },
])
</script>

<template>
  <!-- Bleed out of the main column's padding so the rail sits flush -->
  <div class="-mx-4 -my-6 flex min-h-0 flex-1 flex-col lg:-mx-8 lg:flex-row lg:items-stretch">
    <!-- Sticky rail: the content column scrolls (inside <main>), the nav doesn't.
         100vh minus the topbar (h-14) and breadcrumb strip (h-9) = the scrollport. -->
    <nav
      :aria-label="t('nav.settings')"
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

    <!-- Pane 2: moving between settings sections replaces this column and
         nothing else. The nav beside it is the same nav afterwards, so it must
         not travel — which is exactly what naming the pane instead of <main>
         buys. -->
    <div data-kn-pane="2" class="flex min-h-0 min-w-0 flex-1 flex-col px-4 py-6 lg:px-8">
      <RouterView />
    </div>
  </div>
</template>
