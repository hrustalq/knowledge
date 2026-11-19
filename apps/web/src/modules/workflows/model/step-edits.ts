import type { WorkflowStep, WorkflowStepKind } from '@knowledge/contracts'

/**
 * The step edits two surfaces share (#1246): the popover on the canvas sets a
 * step's kind and output, the drawer its long fields, and both write `produces`.
 */

/**
 * The one output decision, as named outcomes instead of three booleans.
 * "Publishes" and "Publishes without asking" differ only in the review gate, so
 * they belong on one axis rather than in separate checkboxes.
 */
export type StepOutcome = 'items' | 'page' | 'page-auto' | 'internal'

/** `label` / `hint` are i18n keys under `workflow.outcome`. */
export const STEP_OUTCOMES: Array<{ value: StepOutcome; label: string; hint: string }> = [
  { value: 'items', label: 'workflow.outcome.items', hint: 'workflow.outcome.itemsHint' },
  { value: 'page', label: 'workflow.outcome.page', hint: 'workflow.outcome.pageHint' },
  { value: 'page-auto', label: 'workflow.outcome.pageAuto', hint: 'workflow.outcome.pageAutoHint' },
  { value: 'internal', label: 'workflow.outcome.internal', hint: 'workflow.outcome.internalHint' },
]

export function outcomeOf(step: WorkflowStep): StepOutcome {
  if (step.fanOut) return 'items'
  if (!step.produces) return 'internal'
  return step.autoApprove ? 'page-auto' : 'page'
}

export function withProduces(step: WorkflowStep, fields: Partial<NonNullable<WorkflowStep['produces']>>): WorkflowStep {
  return { ...step, produces: { category: 'other', relationToParent: 'IMPLEMENTS', ...step.produces, ...fields } }
}

export function withOutcome(step: WorkflowStep, next: StepOutcome): WorkflowStep {
  const produces = step.produces ?? { category: 'other', relationToParent: 'IMPLEMENTS' }
  if (next === 'items') return { ...step, fanOut: true, autoApprove: false, produces }
  if (next === 'internal') return { ...step, fanOut: false, autoApprove: false, produces: undefined }
  return { ...step, fanOut: false, autoApprove: next === 'page-auto', produces }
}

export function withKind(step: WorkflowStep, kind: WorkflowStepKind): WorkflowStep {
  const ai = kind === 'ai.generate' || kind === 'ai.draft'
  return {
    ...step,
    kind,
    fanOut: kind === 'ai.generate',
    // Switching kind keeps the prompt: doing it by accident should not throw
    // away what someone wrote.
    ...(ai ? { prompt: step.prompt ?? { user: '' } } : {}),
    // Only a drafting step writes into a template; a ref left on another kind
    // would still be checked on save while shaping nothing.
    ...(kind !== 'ai.draft' && step.produces?.templateRef
      ? { produces: { ...step.produces, templateRef: undefined } }
      : {}),
  }
}
