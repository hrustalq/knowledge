// The rail's destinations, as data: AppSidebar draws them, and the route
// prefetcher (app/router/navigation.ts) seeds a new browser's guesses from them.
import type { Component } from 'vue'
import {
  AudioLines,
  BookmarkPlus,
  ChartColumn,
  FlaskConical,
  GitPullRequestArrow,
  HeartPulse,
  House,
  Scale,
  Settings,
  Sparkles,
  Workflow,
} from 'lucide-vue-next'
import type { WorkspaceFeature } from '@knowledge/contracts'

export const NAV_CURRENT = 'bg-primary/10 font-medium text-primary'
export const NAV_IDLE = 'text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-foreground'

export interface NavItem {
  to: string
  labelKey: string
  icon: Component
  feature?: WorkspaceFeature
  /** Drawn for a workspace admin only. */
  workspaceAdmin?: true
}

export const HOME_NAV: NavItem = { to: '/documents', labelKey: 'nav.home', icon: House }

// What looks after the knowledge base as a whole rather than one page (#605),
// folded under one node right below Home so the rail stays short.
export const KNOWLEDGE_NAV: NavItem[] = [
  { to: '/workflows', labelKey: 'nav.workflows', icon: Workflow, feature: 'workflows' },
  // Recordings of your own (#551): proposals you then review.
  { to: '/memos', labelKey: 'nav.memos', icon: AudioLines, feature: 'memos' },
  // The trust loop's review surface (docs/features/40).
  { to: '/knowledge-health', labelKey: 'nav.knowledgeHealth', icon: HeartPulse, feature: 'knowledge-health' },
  // Usage analytics (#79): admins only — it carries what people searched for.
  { to: '/analytics', labelKey: 'nav.analytics', icon: ChartColumn, feature: 'analytics', workspaceAdmin: true },
  // What agents proposed from their sessions (issue #73): page captures are
  // decided on merge requests, but terms and stranded captures only here.
  { to: '/captures', labelKey: 'nav.captures', icon: BookmarkPlus, feature: 'captures' },
  // Contradictions the arbiter found between pages (#81).
  { to: '/conflicts', labelKey: 'nav.conflicts', icon: Scale, feature: 'conflicts' },
]

export const PRIMARY_NAV: NavItem[] = [
  // Search is not a destination — it is the topbar trigger's sheet ("/" or ⌘K).
  { to: '/merge-requests', labelKey: 'nav.mergeRequests', icon: GitPullRequestArrow },
  // Which operations are ready to test (#483).
  { to: '/qa', labelKey: 'nav.qa', icon: FlaskConical, feature: 'qa' },
  { to: '/assistant', labelKey: 'nav.assistant', icon: Sparkles, feature: 'assistant' },
]

// Projects, users, access and activity live under the settings shell.
export const SETTINGS_NAV: NavItem = { to: '/settings', labelKey: 'nav.settings', icon: Settings }
