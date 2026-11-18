import type { RouteRecordRaw } from 'vue-router'
import { AI_PANEL_SECTIONS, DEFAULT_AI_SECTION, isAiSection } from './model/ai-sections'

export const routes: RouteRecordRaw[] = [
  // meta.fill: the chat owns the viewport — see app/App.vue's two content modes.
  // meta.trail 'lg': below lg the breadcrumb only repeated "Assistant" above the
  // chat header and cost a short screen 36px of transcript (#1067).
  { path: '/assistant', component: () => import('./pages/AssistantPage.vue'), meta: { fill: true, feature: 'assistant', trail: 'lg' } },
  // One background run and its step log (#1247). Not behind the `assistant`
  // section: runs are listed to every member, as the API lists them.
  { path: '/agents/runs/:id', component: () => import('./pages/AgentRunPage.vue') },
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
  // Workspace administration that every member reads: gated in the
  // page on `workspace:admin`, not by the router.
  {
    path: `:section(${AI_PANEL_SECTIONS.join('|')})`,
    component: () => import('./pages/AiSectionPage.vue'),
  },
  // A section that no longer exists (or never did) opens the
  // default rather than an empty pane. The wildcard scores below
  // the pattern above, so it only catches what that refused.
  { path: ':unknown(.*)', redirect: `/settings/ai/${DEFAULT_AI_SECTION}` },
]
