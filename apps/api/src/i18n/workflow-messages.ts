import type { WorkflowValidationIssue } from '@knowledge/contracts';
import type { WorkflowTransitionError } from '@knowledge/workflow';
import { t } from './t.js';

/**
 * Localize the prose that packages/workflow produces (docs/features/18).
 *
 * The package stays language-free — it emits a `code` plus params and an
 * English `message` as a default — and the API rewrites `message` in the
 * caller's language before it leaves. The web then renders `issue.message`
 * exactly as it always has, so the catalog lives in one place instead of being
 * duplicated into both apps.
 */
export function localizeIssues(issues: WorkflowValidationIssue[]): WorkflowValidationIssue[] {
  return issues.map((issue) => ({
    ...issue,
    message: t(`workflow.issue.${issue.code}`, issue.params),
  }));
}

/**
 * A refused state transition. `status` is a machine value, so it is translated
 * through its own key rather than interpolated raw — Russian needs it declined.
 * An unknown status falls back to the raw value instead of rendering the key.
 */
export function localizeTransition(error: WorkflowTransitionError, subject: 'run' | 'node'): string {
  const statusKey = `status.${subject === 'run' ? 'run' : 'node'}.${error.status}`;
  const status = t(statusKey);
  return t(subject === 'run' ? 'workflow.transition.badEvent' : 'workflow.transition.badNodeEvent', {
    event: error.event,
    status: status === statusKey ? error.status : status,
  });
}
