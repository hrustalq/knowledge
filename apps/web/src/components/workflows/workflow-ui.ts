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
    label: 'Break down',
    short: 'Break down',
    hint: 'The model breaks the source into a list — one card per item, and the steps below run for each.',
    icon: Sparkles,
  },
  {
    value: 'ai.draft',
    label: 'Write',
    short: 'Write',
    hint: 'The model writes one page, ready to read and publish.',
    icon: FileText,
  },
  {
    value: 'search',
    label: 'Look up',
    short: 'Look up',
    hint: 'No model. Searches the knowledge base and hands what it finds to the next step.',
    icon: Search,
  },
  {
    value: 'review',
    label: 'Wait',
    short: 'Wait',
    hint: 'Stops and waits for a person. No model call.',
    icon: UserCheck,
  },
]

export const stepKind = (kind: WorkflowStepKind) => STEP_KINDS.find((k) => k.value === kind)

export const NODE_STATUS_LABEL: Record<WorkflowNodeStatus, string> = {
  pending: 'Queued',
  running: 'Working',
  'awaiting-review': 'Needs review',
  approved: 'Approved',
  materializing: 'Publishing',
  materialized: 'Published',
  rejected: 'Rejected',
  skipped: 'Skipped',
  failed: 'Failed',
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

export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  pending: 'Starting',
  running: 'Running',
  'awaiting-review': 'Needs review',
  paused: 'Paused',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
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

/** A fresh step, used by the editor's "add step" affordance. */
export function blankStep(kind: WorkflowStepKind, index: number): WorkflowStep {
  return {
    id: `${kind.replace('.', '-')}-${index}`,
    kind,
    title: stepKind(kind)?.label ?? 'Step',
    next: [],
    fanOut: kind === 'ai.generate',
    autoApprove: false,
    ...(kind === 'ai.generate' || kind === 'ai.draft' ? { prompt: { user: '' } } : {}),
  }
}
