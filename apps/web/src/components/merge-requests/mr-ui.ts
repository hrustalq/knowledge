import type { Component } from 'vue'
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-vue-next'
import type { MergeRequestInfo } from '@knowledge/contracts'
import { formatDateTime, formatRelative } from '@/lib/format'

/**
 * GitLab-style MR state iconography, mapped onto the app's status colors.
 *
 * `label` is a message key, not text: this is a module function and cannot call
 * useI18n(). Call sites resolve it with t() (docs/features/18).
 */
export function mrIcon(mr: Pick<MergeRequestInfo, 'status' | 'isDraft'>): { icon: Component; class: string; label: string } {
  if (mr.status === 'merged') return { icon: GitMerge, class: 'text-violet-500', label: 'mr.state.merged' }
  if (mr.status === 'closed') return { icon: GitPullRequestClosed, class: 'text-red-500', label: 'mr.state.closed' }
  if (mr.isDraft) return { icon: GitPullRequestDraft, class: 'text-muted-foreground', label: 'mr.state.draft' }
  return { icon: GitPullRequestArrow, class: 'text-emerald-500', label: 'mr.state.open' }
}

/** Stub/zeros ids read as "dev" everywhere else in the UI (see ActivityFeed). */
export function actorLabel(id: string | null | undefined): string {
  if (!id || id === '00000000-0000-0000-0000-000000000000' || id === 'dev') return 'dev'
  return id.slice(0, 8)
}

/**
 * Timestamps for the review timeline.
 *
 * `relativeTime` falls back to a full locale string after a day — date, time
 * and seconds — which in a dense feed is both more precision than anyone
 * wants and a ragged right edge next to "3m ago". These trade the seconds for
 * a short date and keep the exact value on the element's `title`.
 */
export function timelineTime(iso: string): string {
  return formatRelative(iso)
}

/** The exact stamp, for a `title` on whatever `timelineTime` shortened. */
export function fullTime(iso: string): string {
  return formatDateTime(iso)
}
