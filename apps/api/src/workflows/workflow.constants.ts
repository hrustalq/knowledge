export const WORKFLOW_QUEUE = 'workflow';

/** Retry ceiling for the sweeper. A node that has failed this often needs a
 *  person to look at the prompt, not another model call. */
export const WORKFLOW_MAX_ATTEMPTS = 3;

/**
 * The `withSubjectLock` key behind "one live run per (definition, page)"
 * (#815), taken by the manual start and the event trigger alike.
 */
export const workflowRunLockKey = (definitionId: string, documentId: string): string =>
  `workflow-run:${definitionId}:${documentId}`;
