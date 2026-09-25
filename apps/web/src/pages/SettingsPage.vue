<script setup lang="ts">
// Settings shell: nested pages (projects / access / activity / …) rendered in
// the content column, with their own nav rail flush against the left edge.
import { useI18n } from 'vue-i18n'
import { computed, type Component } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import {
  Activity,
  Bell,
  BookMarked,
  BookOpen,
  Bot,
  FolderKanban,
  Plug,
  ShieldCheck,
  Sparkles,
  UserRound,
  Workflow,
} from 'lucide-vue-next'
import { PageLayout, PageSubRail } from '@/components/layout/page'

const { t } = useI18n()

const route = useRoute()

interface SettingsLink { to: string; label: string; icon: Component; hint: string }
const links = computed<SettingsLink[]>(() => [
  // First, and open to every role: the only section that acts on you rather
  // than on the workspace.
  { to: '/settings/profile', label: t('nav.profile'), icon: UserRound, hint: t('settings.profileHint') },
  { to: '/settings/notifications', label: t('nav.notifications'), icon: Bell, hint: t('settings.notificationsHint') },
  { to: '/settings/connect', label: t('nav.connect'), icon: Bot, hint: t('settings.connectHint') },
  { to: '/settings/projects', label: t('nav.projects'), icon: FolderKanban, hint: t('settings.projectsHint') },
  { to: '/settings/glossary', label: t('nav.glossary'), icon: BookMarked, hint: t('settings.glossaryHint') },
  // Members, roles and — for a platform admin — the accounts themselves, all
  // under one row. Accounts used to be a second row beside this one, which put
  // "can this person sign in" and "what may they do here" in two places and
  // gave a workspace admin a nav row that only ever 403'd.
  { to: '/settings/access', label: t('nav.access'), icon: ShieldCheck, hint: t('settings.accessHint') },
  { to: '/settings/activity', label: t('nav.activity'), icon: Activity, hint: t('settings.activityHint') },
  { to: '/settings/ai', label: t('nav.ai'), icon: Sparkles, hint: t('settings.aiHint') },
  { to: '/settings/workflows', label: t('nav.workflows'), icon: Workflow, hint: t('settings.workflowsHint') },
  { to: '/settings/connectors', label: t('nav.connectors'), icon: Plug, hint: t('settings.connectorsHint') },
  // Last, and open to every role: it is the section you go to when one of the
  // others did not explain itself.
  { to: '/settings/docs', label: t('nav.docs'), icon: BookOpen, hint: t('settings.docsHint') },
])

// A segment match, not a prefix: /settings/connect is a prefix of
// /settings/connectors, and both rows lit up at once.
function isActive(to: string): boolean {
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <!--
    A shell, not a page: the bleed, the flush nav column and the padded content
    column are the layout's business now, and `:measure="false"` is what says
    this hosts child routes rather than content of its own — each section knows
    whether it is a form or a table, and capping here would answer for it.

    Pane 2: moving between settings sections replaces the content column and
    nothing else. The nav beside it is the same nav afterwards, so it must not
    travel — which is exactly what naming the pane instead of <main> buys. The
    attribute reaches the column through PageLayout's attribute forwarding.
  -->
  <PageLayout variant="list" :measure="false" data-kn-pane="2">
    <template #sub-rail>
      <PageSubRail :label="t('nav.settings')" permanent>
        <ul class="flex gap-1 overflow-x-auto px-2 py-2 lg:block lg:space-y-px lg:overflow-visible lg:p-0">
          <li v-for="l in links" :key="l.to">
            <RouterLink
              :to="l.to"
              class="flex items-center gap-2.5 px-3 py-2 text-sm transition-colors lg:rounded-none"
              :class="isActive(l.to)
                ? 'bg-primary/10 font-medium text-primary'
                : 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'"
            >
              <component :is="l.icon" class="size-4 shrink-0" />
              <span class="min-w-0">
                <span class="block truncate">{{ l.label }}</span>
                <span class="hidden truncate text-[11px] text-muted-foreground lg:block">{{ l.hint }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </PageSubRail>
    </template>

    <RouterView />
  </PageLayout>
</template>
