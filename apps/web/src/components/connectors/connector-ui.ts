import {
  Ban,
  Check,
  CheckCheck,
  CircleDashed,
  CircleSlash,
  Equal,
  FilePlus2,
  FilePen,
  GitMerge,
  Loader2,
  PauseCircle,
  TriangleAlert,
  Undo2,
  UserCheck,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type {
  ConnectorItemAction,
  ConnectorItemEventType,
  ConnectorRunItemInfo,
  ConnectorRunItemStatus,
  ConnectorRunPhase,
  ConnectorRunStatus,
} from '@knowledge/contracts'

/**
 * One vocabulary for connector run icons and labels (docs/features/26), so the
 * run page, the item tree, the review pane and the Runs tab cannot disagree
 * about what a status looks like — the job `workflow-ui.ts` does for workflows
 * and `mr-ui.ts` for merge requests.
 *
 * Every string here is a **message key**, not a label: this is a module
 * constant and cannot call `useI18n()`. Render sites resolve them with
 * `t(ITEM_STATUS_LABEL[status])` (docs/features/18) — and the render site has
 * to actually resolve them, which is the mistake that shipped `nav.ai` at a
 * reader once already.
 */

export const ITEM_STATUS_LABEL: Record<ConnectorRunItemStatus, string> = {
  discovered: 'connectors.itemStatus.discovered',
  fetching: 'connectors.itemStatus.fetching',
  staged: 'connectors.itemStatus.staged',
  approved: 'connectors.itemStatus.approved',
  applying: 'connectors.itemStatus.applying',
  applied: 'connectors.itemStatus.applied',
  unchanged: 'connectors.itemStatus.unchanged',
  skipped: 'connectors.itemStatus.skipped',
  rejected: 'connectors.itemStatus.rejected',
  failed: 'connectors.itemStatus.failed',
  reverted: 'connectors.itemStatus.reverted',
}

export const ITEM_STATUS_ICON: Record<ConnectorRunItemStatus, Component> = {
  discovered: CircleDashed,
  fetching: Loader2,
  staged: UserCheck,
  approved: Check,
  applying: Loader2,
  applied: CheckCheck,
  unchanged: Equal,
  skipped: CircleSlash,
  rejected: Ban,
  failed: TriangleAlert,
  reverted: Undo2,
}

export const ITEM_STATUS_CLASS: Record<ConnectorRunItemStatus, string> = {
  discovered: 'text-muted-foreground',
  fetching: 'text-primary',
  staged: 'text-amber-600 dark:text-amber-500',
  approved: 'text-emerald-600 dark:text-emerald-500',
  applying: 'text-primary',
  applied: 'text-emerald-600 dark:text-emerald-500',
  // Deliberately the quietest state in the set. On a second sync almost every
  // row is `unchanged`, and a wall of coloured ticks would bury the two rows
  // that actually changed.
  unchanged: 'text-muted-foreground/70',
  skipped: 'text-muted-foreground',
  rejected: 'text-muted-foreground',
  failed: 'text-destructive',
  reverted: 'text-muted-foreground',
}

/**
 * What applying an item would *do*. Reported separately from status because the
 * two answer different questions: status is how far along this row is, action
 * is what the knowledge base gets if it finishes.
 */
export const ACTION_LABEL: Record<ConnectorItemAction, string> = {
  create: 'connectors.action.create',
  update: 'connectors.action.update',
  unchanged: 'connectors.action.unchanged',
  conflict: 'connectors.action.conflict',
}

export const ACTION_ICON: Record<ConnectorItemAction, Component> = {
  create: FilePlus2,
  update: FilePen,
  unchanged: Equal,
  conflict: GitMerge,
}

export const ACTION_CLASS: Record<ConnectorItemAction, string> = {
  create: 'text-emerald-600 dark:text-emerald-500',
  update: 'text-primary',
  unchanged: 'text-muted-foreground',
  conflict: 'text-amber-600 dark:text-amber-500',
}

export const RUN_STATUS_LABEL: Record<ConnectorRunStatus, string> = {
  queued: 'connectors.status.queued',
  running: 'connectors.status.running',
  paused: 'connectors.status.paused',
  'awaiting-review': 'connectors.status.awaiting-review',
  succeeded: 'connectors.status.succeeded',
  partial: 'connectors.status.partial',
  failed: 'connectors.status.failed',
  cancelled: 'connectors.status.cancelled',
}

export const RUN_STATUS_ICON: Record<ConnectorRunStatus, Component> = {
  queued: CircleDashed,
  running: Loader2,
  paused: PauseCircle,
  'awaiting-review': UserCheck,
  succeeded: Check,
  partial: TriangleAlert,
  failed: TriangleAlert,
  cancelled: CircleSlash,
}

export const RUN_STATUS_CLASS: Record<ConnectorRunStatus, string> = {
  queued: 'text-muted-foreground',
  running: 'text-primary',
  paused: 'text-muted-foreground',
  'awaiting-review': 'text-amber-600 dark:text-amber-500',
  succeeded: 'text-emerald-600 dark:text-emerald-500',
  partial: 'text-amber-600 dark:text-amber-500',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
}

export const PHASE_LABEL: Record<ConnectorRunPhase, string> = {
  discovering: 'connectors.phase.discovering',
  fetching: 'connectors.phase.fetching',
  'awaiting-review': 'connectors.phase.awaiting-review',
  applying: 'connectors.phase.applying',
  reverting: 'connectors.phase.reverting',
}

/** The per-item buttons. Which ones are *legal* comes from `allowedItemEvents`. */
export const ITEM_EVENT_LABEL: Record<ConnectorItemEventType, string> = {
  APPROVE: 'connectors.event.approve',
  SKIP: 'connectors.event.skip',
  REJECT: 'connectors.event.reject',
  RETRY: 'connectors.event.retry',
  REVERT: 'connectors.event.revert',
}

/**
 * The same two verbs, said of a whole branch.
 *
 * Separate messages rather than a label plus an appended "(subtree)": Russian
 * needs a case the English fragment does not carry, and a composed sentence is
 * translated whole (docs/features/18).
 */
export const SUBTREE_EVENT_LABEL = {
  APPROVE: 'connectors.event.approveSubtree',
  SKIP: 'connectors.event.skipSubtree',
} as const

export const RUN_EVENT_LABEL = {
  PAUSE: 'connectors.event.pause',
  RESUME: 'connectors.event.resume',
  NEXT: 'connectors.event.next',
  CANCEL: 'connectors.event.cancel',
  APPROVE_ALL: 'connectors.event.approveAll',
} as const

/** A status that spins wants the animation class; nothing else should. */
export const isBusyItem = (status: ConnectorRunItemStatus): boolean =>
  status === 'fetching' || status === 'applying'

/** Whether the run is still moving — i.e. whether to keep polling it. */
export const isRunActive = (status: ConnectorRunStatus): boolean =>
  status === 'queued' || status === 'running' || status === 'paused' || status === 'awaiting-review'

/** The one state worth a colour in a long tree: this row is waiting on you. */
export const wantsReview = (item: ConnectorRunItemInfo): boolean => item.status === 'staged'

/** One item plus the branch under it. */
export interface ItemNode {
  item: ConnectorRunItemInfo
  children: ItemNode[]
}

/**
 * The tree, from flat rows joined by `parentItemId`.
 *
 * Nested rather than flattened to depth-tagged rows, because a branch here
 * genuinely collapses: a Confluence space is hundreds of pages and a reviewer
 * works one section at a time. The workflow run tree flattens because a
 * generated chain is a dozen nodes that should all stay visible — the opposite
 * problem.
 *
 * Two details matter. Children are ordered by the server's `position`, so a
 * branch reads in the external system's own order rather than in whatever order
 * rows arrived. And an item whose parent is missing — the walk was paused, or
 * truncated, before it reached the parent — is attached at the root rather than
 * dropped: a row that exists and renders nowhere is how a page silently goes
 * missing from a review.
 */
export function nestItems(items: ConnectorRunItemInfo[]): ItemNode[] {
  const byParent = new Map<string | null, ConnectorRunItemInfo[]>()
  for (const item of items) {
    byParent.set(item.parentItemId, [...(byParent.get(item.parentItemId) ?? []), item])
  }
  for (const list of byParent.values()) list.sort((a, b) => a.position - b.position)

  const seen = new Set<string>()
  const build = (parentId: string | null): ItemNode[] =>
    (byParent.get(parentId) ?? []).flatMap((item) => {
      // A cycle cannot happen through a self-FK the server maintains, but a
      // guard here is cheaper than a hung render if one ever does.
      if (seen.has(item.id)) return []
      seen.add(item.id)
      return [{ item, children: build(item.id) }]
    })

  const roots = build(null)
  for (const item of items) {
    if (!seen.has(item.id)) {
      seen.add(item.id)
      roots.push({ item, children: build(item.id) })
    }
  }
  return roots
}

/** Every descendant of `id`, for the subtree actions' confirmation counts. */
export function descendantsOf<T extends { id: string; parentItemId: string | null }>(
  items: T[],
  id: string,
): T[] {
  const byParent = new Map<string | null, T[]>()
  for (const item of items) {
    byParent.set(item.parentItemId, [...(byParent.get(item.parentItemId) ?? []), item])
  }
  const out: T[] = []
  const queue = [id]
  const seen = new Set<string>([id])
  for (let head = 0; head < queue.length; head++) {
    for (const child of byParent.get(queue[head]!) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}
