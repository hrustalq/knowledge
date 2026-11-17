import { CircleAlert, CircleCheck, CircleSlash, Clock, Loader2 } from 'lucide-vue-next'
import type { AgentRunStatus } from '@knowledge/contracts'

/** A run's status as an icon — the runs list and the run page (#1247) read one table. */
export const RUN_STATUS_ICON = {
  pending: Clock,
  running: Loader2,
  succeeded: CircleCheck,
  failed: CircleAlert,
  // Its own shape: a cancelled run is not a failed one, and the icon is what
  // a reader scans the list by.
  cancelled: CircleSlash,
} as const

export const runStatusClass = (status: AgentRunStatus) => [
  status === 'failed' && 'text-destructive dark:text-destructive-foreground',
  status === 'succeeded' && 'text-panel-tip-ink',
  status === 'running' && 'animate-spin motion-reduce:animate-none',
]

export const isLiveRun = (status: AgentRunStatus) => status === 'pending' || status === 'running'
