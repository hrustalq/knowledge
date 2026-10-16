/**
 * The sections of /settings/ai (issue #182), in rail order.
 *
 * One list read by three consumers — the router's section pattern, the rail in
 * `AiSettingsPage` and the breadcrumb — so a section added here is routable,
 * listed and named at once, and cannot be one without the others.
 *
 * Plain data on purpose: the breadcrumb lives in the layout's main chunk, and
 * the panels behind these keys must not follow it there.
 */

export const AI_SECTION_GROUPS = [
  // Yours, and open to every role: the one section that acts on your own keys
  // rather than on the workspace, which is why it carries no read-only badge.
  { label: 'ai.rail.yours', sections: [{ key: 'connect', label: 'nav.connect' }] },
  // What connected coding agents may propose back (issue #73). Its own group:
  // it governs the agents Connect sets up, not the workspace's assistant.
  { label: 'ai.rail.connected', sections: [{ key: 'capture', label: 'ai.tabCapture' }] },
  {
    label: 'ai.rail.assistant',
    sections: [
      { key: 'config', label: 'ai.tabConfig' },
      { key: 'agents', label: 'ai.tabAgents' },
      { key: 'skills', label: 'ai.tabSkills' },
      { key: 'learnings', label: 'ai.tabLearnings' },
      { key: 'plugins', label: 'ai.tabPlugins' },
    ],
  },
  {
    label: 'ai.rail.quality',
    sections: [
      { key: 'coverage', label: 'ai.tabCoverage' },
      { key: 'feedback', label: 'ai.tabFeedback' },
    ],
  },
  {
    label: 'ai.rail.activity',
    sections: [
      { key: 'runs', label: 'ai.tabRuns' },
      { key: 'usage', label: 'ai.tabUsage' },
      { key: 'logs', label: 'ai.tabLogs' },
    ],
  },
] as const

type AiSection = (typeof AI_SECTION_GROUPS)[number]['sections'][number]
export type AiSectionKey = AiSection['key']

export const AI_SECTIONS: readonly AiSection[] = AI_SECTION_GROUPS.flatMap(
  (group): readonly AiSection[] => group.sections,
)

/** The workspace-admin sections — every one except Connect. */
export const AI_PANEL_SECTIONS = AI_SECTIONS.map((s) => s.key).filter((key) => key !== 'connect')

/**
 * Bare `/settings/ai` opens Connect: the first row, and the one section every
 * role can use, so a non-admin never lands on a page of read-only panels.
 */
export const DEFAULT_AI_SECTION: AiSectionKey = 'connect'

export function isAiSection(value: unknown): value is AiSectionKey {
  return AI_SECTIONS.some((s) => s.key === value)
}

/** Message key naming a section, or undefined for anything that is not one. */
export function aiSectionLabel(key: unknown): string | undefined {
  return AI_SECTIONS.find((s) => s.key === key)?.label
}
