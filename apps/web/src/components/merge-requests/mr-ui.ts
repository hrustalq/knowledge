import type { Component } from 'vue'
import { GitMerge, GitPullRequestArrow, GitPullRequestClosed, GitPullRequestDraft } from 'lucide-vue-next'
import type { MergeRequestInfo } from '@knowledge/contracts'

/** GitLab-style MR state iconography, mapped onto the app's status colors. */
export function mrIcon(mr: Pick<MergeRequestInfo, 'status' | 'isDraft'>): { icon: Component; class: string; label: string } {
  if (mr.status === 'merged') return { icon: GitMerge, class: 'text-violet-500', label: 'merged' }
  if (mr.status === 'closed') return { icon: GitPullRequestClosed, class: 'text-red-500', label: 'closed' }
  if (mr.isDraft) return { icon: GitPullRequestDraft, class: 'text-muted-foreground', label: 'draft' }
  return { icon: GitPullRequestArrow, class: 'text-emerald-500', label: 'open' }
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
  const at = new Date(iso)
  const seconds = Math.round((Date.now() - at.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  const thisYear = at.getFullYear() === new Date().getFullYear()
  return at.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(thisYear ? {} : { year: 'numeric' }),
  })
}

/** The exact stamp, for a `title` on whatever `timelineTime` shortened. */
export function fullTime(iso: string): string {
  return new Date(iso).toLocaleString()
}
