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
