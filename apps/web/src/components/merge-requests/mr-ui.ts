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

/** The AUTH_MODE=none principal, in both spellings it reaches the client as. */
export const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000000'

/** Stub/zeros ids read as "dev" everywhere else in the UI (see ActivityFeed). */
export function actorLabel(id: string | null | undefined): string {
  if (!id || id === DEV_ACTOR_ID || id === 'dev') return 'dev'
  return id.slice(0, 8)
}

/**
 * Does this actor have a profile behind it?
 *
 * Activity rows are written by three kinds of actor: real accounts, the dev
 * principal (no `users` row), and agents (a slug key, not an id). Only the first
 * has a page to open, so only the first gets a chip. The API answers the same
 * question with `activity/actor.ts`; this is its client-side half, and the
 * literal lives in one place on each side rather than four.
 */
export function isRealAccount(actor: string | null | undefined): boolean {
  return !!actor && actor !== DEV_ACTOR_ID && UUID_RE.test(actor)
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
