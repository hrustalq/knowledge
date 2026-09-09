import {
  Ban,
  Check,
  CircleDashed,
  CircleSlash,
  FileText,
  Loader2,
  PauseCircle,
  Search,
  Sparkles,
  TriangleAlert,
  UserCheck,
} from 'lucide-vue-next'
import type { Component } from 'vue'
import type {
  WorkflowNodeStatus,
  WorkflowRunStatus,
  WorkflowStep,
  WorkflowStepKind,
} from '@knowledge/contracts'

/**
 * One vocabulary for workflow icons and labels (docs/features/17), so the run
 * tree, the run cards, the rail widget and the graph editor cannot disagree
 * about what a status looks like — the same job `mr-ui.ts` does for merge
 * requests.
 */

/** `label`, `short` and `hint` are i18n message keys — resolve with `t()` at the render site. */
export const STEP_KINDS: Array<{
  value: WorkflowStepKind
  label: string
  /** One or two words for the segmented control, where four share a row. */
  short: string
  hint: string
  icon: Component
}> = [
  {
    value: 'ai.generate',
    label: 'workflow.stepKind.generate',
    short: 'workflow.stepKind.generate',
    hint: 'workflow.stepKind.generateHint',
    icon: Sparkles,
  },
  {
    value: 'ai.draft',
    label: 'workflow.stepKind.draft',
    short: 'workflow.stepKind.draft',
    hint: 'workflow.stepKind.draftHint',
    icon: FileText,
  },
  {
    value: 'search',
    label: 'workflow.stepKind.search',
    short: 'workflow.stepKind.search',
    hint: 'workflow.stepKind.searchHint',
    icon: Search,
  },
  {
    value: 'review',
    label: 'workflow.stepKind.review',
    short: 'workflow.stepKind.review',
    hint: 'workflow.stepKind.reviewHint',
    icon: UserCheck,
  },
]

export const stepKind = (kind: WorkflowStepKind) => STEP_KINDS.find((k) => k.value === kind)

/**
 * Message keys, not labels: this is a module constant, so it cannot call
 * useI18n(). Components resolve it with `t(NODE_STATUS_LABEL[status])`
 * (docs/features/18).
 */
export const NODE_STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  pending: 'workflow.nodeStatus.pending',
  running: 'workflow.nodeStatus.running',
  'awaiting-review': 'workflow.nodeStatus.awaiting-review',
  approved: 'workflow.nodeStatus.approved',
  materializing: 'workflow.nodeStatus.materializing',
  materialized: 'workflow.nodeStatus.materialized',
  rejected: 'workflow.nodeStatus.rejected',
  skipped: 'workflow.nodeStatus.skipped',
  failed: 'workflow.nodeStatus.failed',
}

export const NODE_STATUS_ICON: Record<WorkflowNodeStatus, Component> = {
  pending: CircleDashed,
  running: Loader2,
  'awaiting-review': UserCheck,
  approved: Check,
  materializing: Loader2,
  materialized: Check,
  rejected: Ban,
  skipped: CircleSlash,
  failed: TriangleAlert,
}

/** Tailwind text colours; kept here so a status reads the same everywhere. */
export const NODE_STATUS_CLASS: Record<WorkflowNodeStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary',
  'awaiting-review': 'text-amber-600 dark:text-amber-500',
  approved: 'text-emerald-600 dark:text-emerald-500',
  materializing: 'text-primary',
  materialized: 'text-emerald-600 dark:text-emerald-500',
  rejected: 'text-muted-foreground',
  skipped: 'text-muted-foreground',
  failed: 'text-destructive',
}

/** Message keys — see NODE_STATUS_LABEL. */
export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  pending: 'workflow.runStatus.pending',
  running: 'workflow.runStatus.running',
  'awaiting-review': 'workflow.runStatus.awaiting-review',
  paused: 'workflow.runStatus.paused',
  completed: 'workflow.runStatus.completed',
  failed: 'workflow.runStatus.failed',
  cancelled: 'workflow.runStatus.cancelled',
}

export const RUN_STATUS_ICON: Record<WorkflowRunStatus, Component> = {
  pending: CircleDashed,
  running: Loader2,
  'awaiting-review': UserCheck,
  paused: PauseCircle,
  completed: Check,
  failed: TriangleAlert,
  cancelled: CircleSlash,
}

export const RUN_STATUS_CLASS: Record<WorkflowRunStatus, string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary',
  'awaiting-review': 'text-amber-600 dark:text-amber-500',
  paused: 'text-muted-foreground',
  completed: 'text-emerald-600 dark:text-emerald-500',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
}

/** A status that spins wants an animation class; nothing else should. */
export const isBusyStatus = (status: WorkflowNodeStatus | WorkflowRunStatus): boolean =>
  status === 'running' || status === 'materializing'

/**
 * A fresh step, used by the editor's "add step" affordance. `title` is persisted
 * definition data, so the caller resolves the default label in its own locale.
 */
export function blankStep(kind: WorkflowStepKind, index: number, title: string): WorkflowStep {
  return {
    id: `${kind.replace('.', '-')}-${index}`,
    kind,
    title,
    next: [],
    fanOut: kind === 'ai.generate',
    autoApprove: false,
    ...(kind === 'ai.generate' || kind === 'ai.draft' ? { prompt: { user: '' } } : {}),
  }
}
