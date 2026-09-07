// System notes for the merge-request timeline.
//
// The feed interleaves two kinds of row: discussion threads, which carry
// their own card, and these — the state changes recorded in the activity log
// (docs/features/10) with `subjectId` set to the merge request id.
//
// Comment activity is deliberately dropped. Every comment already exists in
// the timeline as its own thread, so replaying it as "dev commented on this
// merge request" would double every conversation and bury the state changes
// the feed exists to show.
import type { Component } from 'vue'
import {
  CheckCircle2,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  Pencil,
  RotateCcw,
  UserPlus,
} from 'lucide-vue-next'
import type { ActivityEntry } from '@knowledge/contracts'

export interface SystemNote {
  icon: Component
  /** Icon tint — the same status vocabulary as mrIcon(). */
  tone: string
  /** Predicate following the actor's name: "dev {text}". */
  text: string
  /** Revision id rendered as a mono chip after the text, when there is one. */
  code?: string
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/** Clauses for a `merge-request.updated` row, which can carry several edits at once. */
function editClauses(meta: Record<string, unknown>, nameOf: (id: string) => string): string[] {
  const changed = Array.isArray(meta.changed) ? (meta.changed as string[]) : []
  const clauses: string[] = []
  // Rows written before the value was recorded alongside the field name say
  // only *that* it changed. Guessing the direction there would invent history,
  // so those degrade to the neutral phrasing instead.
  if (changed.includes('isDraft')) {
    if (meta.isDraft === false) clauses.push('marked this as ready for review')
    else if (meta.isDraft === true) clauses.push('marked this as a draft')
    else clauses.push('changed the draft status')
  }
  if (changed.includes('assigneeId')) {
    const assignee = str(meta.assigneeId)
    if (assignee) clauses.push(`assigned this to ${nameOf(assignee)}`)
    else if ('assigneeId' in meta) clauses.push('removed the assignee')
    else clauses.push('changed the assignee')
  }
  if (changed.includes('title')) clauses.push('changed the title')
  if (changed.includes('description')) clauses.push('edited the description')
  return clauses
}

/**
 * One activity row → the note to render, or `null` for actions the timeline
 * shows some other way (or not at all).
 */
export function systemNote(
  entry: ActivityEntry,
  nameOf: (id: string) => string,
): SystemNote | null {
  const meta = entry.metadata ?? {}

  switch (entry.action) {
    case 'merge-request.created':
      return { icon: GitPullRequestArrow, tone: 'text-emerald-500', text: 'opened this merge request' }

    case 'merge-request.updated': {
      const clauses = editClauses(meta, nameOf)
      if (clauses.length === 0) return null
      const text =
        clauses.length === 1
          ? clauses[0]
          : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
      return { icon: Pencil, tone: 'text-muted-foreground', text }
    }

    case 'merge-request.review-requested': {
      const ids = Array.isArray(meta.reviewerIds) ? (meta.reviewerIds as string[]) : []
      const who = ids.length > 0 ? ids.map(nameOf).join(', ') : 'a reviewer'
      return { icon: UserPlus, tone: 'text-sky-500', text: `requested review from ${who}` }
    }

    case 'merge-request.approved':
      return { icon: CheckCircle2, tone: 'text-emerald-500', text: 'approved this merge request' }

    case 'merge-request.closed':
      return { icon: GitPullRequestClosed, tone: 'text-red-500', text: 'closed this merge request' }

    case 'merge-request.reopened':
      return { icon: RotateCcw, tone: 'text-emerald-500', text: 'reopened this merge request' }

    case 'merge-request.merged': {
      const strategy = str(meta.strategy)
      const revision = str(meta.mergedRevisionId)
      return {
        icon: GitMerge,
        tone: 'text-violet-500',
        text: strategy === 'squash' ? 'merged this as a squashed revision' : 'merged this with a merge commit',
        ...(revision ? { code: revision.slice(0, 8) } : {}),
      }
    }

    // Threads render themselves; see the note at the top of this file.
    default:
      return null
  }
}
