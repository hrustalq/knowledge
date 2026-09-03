import type { CompareResponse, MergeRequestThread } from '@knowledge/contracts'

/**
 * Best-effort anchor resolution (plan.md §8): a line anchor pins the source
 * head revision at comment time. It renders inline only while the diff's `to`
 * side is still that revision; after the branch advances we try to re-match by
 * excerpt, and otherwise the thread falls back to the Discussion tab marked
 * "outdated" — anchors are never silently re-attached to a different line.
 */
export interface MatchedThreads {
  /** new-side line number → threads rendered inline in the diff */
  inline: Map<number, MergeRequestThread[]>
  /** unanchored threads + line threads whose anchor no longer resolves */
  discussion: MergeRequestThread[]
  /** subset of `discussion` whose anchor exists but no longer resolves */
  outdatedIds: Set<string>
}

export function matchAnchoredThreads(
  compare: CompareResponse | null,
  threads: MergeRequestThread[],
): MatchedThreads {
  const inline = new Map<number, MergeRequestThread[]>()
  const discussion: MergeRequestThread[] = []
  const outdatedIds = new Set<string>()

  const newLines = new Map<number, string>()
  for (const hunk of compare?.hunks ?? []) {
    for (const line of hunk.lines) {
      if (line.kind !== 'deleted' && line.new !== undefined) newLines.set(line.new, line.text)
    }
  }

  for (const thread of threads) {
    const anchor = thread.anchor
    if (!anchor || anchor.type !== 'line' || !compare) {
      // section/entity anchors are listed in the discussion tab (with their
      // anchor label) — they have no line position inside the text diff.
      discussion.push(thread)
      continue
    }
    const current = anchor.revisionId === compare.to.revisionId && newLines.has(anchor.line)
    const rematched = !current && anchor.excerpt
      ? [...newLines.entries()].find(([, text]) => text === anchor.excerpt)?.[0]
      : undefined
    const line = current ? anchor.line : rematched
    if (line !== undefined) {
      inline.set(line, [...(inline.get(line) ?? []), thread])
    } else {
      outdatedIds.add(thread.threadId)
      discussion.push(thread)
    }
  }
  return { inline, discussion, outdatedIds }
}
