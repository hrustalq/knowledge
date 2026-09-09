import { GitPullRequestArrow, MessageSquare, PenLine, Waypoints } from 'lucide-vue-next'
import type { Component } from 'vue'
import { ACTIVITY_KINDS, type ActivityKind } from '@knowledge/contracts'

/**
 * How the four activity kinds look. The kinds themselves — and the reading of
 * an action into one — live in `@knowledge/contracts`, shared with the API;
 * this file only decides how they are drawn.
 *
 * Colour rationing follows the Reserved Signal Rule: emerald, amber and red
 * belong to the indexing lifecycle, so three kinds take cool panel hues and the
 * fourth takes no hue at all. That is not a compromise — `curate` is the
 * catch-all bucket (relations, glossary, projects, workflows, settings), and
 * rendering the bucket as graphite says so more honestly than a fourth colour
 * would, while keeping this page to the palette's two temperatures.
 */
export interface ActivityKindStyle {
  kind: ActivityKind
  /** CSS colour value — a token reference, never a literal. */
  color: string
  icon: Component
  /** i18n key for the kind's own name. */
  labelKey: string
}

const STYLES: Record<ActivityKind, Omit<ActivityKindStyle, 'kind'>> = {
  write: { color: 'var(--primary)', icon: PenLine, labelKey: 'profile.kind.write' },
  review: { color: 'var(--kn-panel-important)', icon: GitPullRequestArrow, labelKey: 'profile.kind.review' },
  discuss: { color: 'var(--kn-panel-note)', icon: MessageSquare, labelKey: 'profile.kind.discuss' },
  curate: { color: 'var(--muted-foreground)', icon: Waypoints, labelKey: 'profile.kind.curate' },
}

export const ACTIVITY_KIND_STYLES: ActivityKindStyle[] = ACTIVITY_KINDS.map((kind) => ({
  kind,
  ...STYLES[kind],
}))

export function activityKindStyle(kind: ActivityKind): ActivityKindStyle {
  return { kind, ...STYLES[kind] }
}
