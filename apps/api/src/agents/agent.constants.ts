export const AGENT_QUEUE = 'agent';

/**
 * Retry ceiling for the stale sweeper. A run that has failed this often needs a
 * person to look at the prompt, not another model call — the same reasoning as
 * WORKFLOW_MAX_ATTEMPTS.
 */
export const AGENT_MAX_ATTEMPTS = 3;

/**
 * Warnings kept on one run (docs/features/29).
 *
 * A run reports what degraded without failing — a page it could not read, a
 * graph store that was down. Capped for the reason `connector_runs` caps its
 * own: the row is polled, and a run that degrades on every one of sixty pages
 * would otherwise carry sixty lines of the same sentence into every poll.
 */
export const MAX_RUN_WARNINGS = 20;
