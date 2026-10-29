import type { RouteRecordRaw } from 'vue-router'
import { AI_PANEL_SECTIONS, DEFAULT_AI_SECTION, isAiSection } from './model/ai-sections'

export const routes: RouteRecordRaw[] = [
  // meta.fill: the chat owns the viewport — see app/App.vue's two content modes.
  { path: '/assistant', component: () => import('./pages/AssistantPage.vue'), meta: { fill: true, feature: 'assistant' } },
]

// AI (issue #182): Connect AI plus the assistant's provider config,
// agents, skills, plugins, quality, usage and logs. Third rail, as
// docs: the section rail lives in the shell, the section here. Connect AI
// is access's page; app/router adds it to `children`.
export const aiSettingsRoute: RouteRecordRaw = {
  path: 'ai',
  component: () => import('./pages/AiSettingsPage.vue'),
}

export const aiSectionRoutes: RouteRecordRaw[] = [
  // Bare `/settings/ai` opens the default section, and the old
  // `?tab=<x>` links — agent-run notifications among them — open
  // the section the tab became. Every other query rides along.
  {
    path: '',
    redirect: (to) => {
      const { tab, ...query } = to.query
      return { path: `/settings/ai/${isAiSection(tab) ? tab : DEFAULT_AI_SECTION}`, query }
    },
  },
  // Workspace administration. Gated in the page on workspace admin
  // rather than meta.platformAdmin — these are workspace settings,
  // not platform ones.
  {
    path: `:section(${AI_PANEL_SECTIONS.join('|')})`,
    component: () => import('./pages/AiSectionPage.vue'),
  },
  // A section that no longer exists (or never did) opens the
  // default rather than an empty pane. The wildcard scores below
  // the pattern above, so it only catches what that refused.
  { path: ':unknown(.*)', redirect: `/settings/ai/${DEFAULT_AI_SECTION}` },
]
