import type { WorkflowGraph, WorkflowValidationIssue } from '@knowledge/contracts';
import type { TemplatesService } from '../templates/templates.service.js';

/**
 * `produces.templateRef` checked against the workspace (issue #69).
 *
 * The other half of `validateGraph`, which is pure and shared with the browser,
 * so it has no database to ask whether a template exists. A ref that does not
 * resolve here, or names an archived or hidden template, is an error at save
 * rather than a node failing hours later in the worker. A definition already
 * saved against a template that is archived afterwards keeps running: the
 * executor resolves archived templates, so only a new save is refused.
 *
 * The message is English, like the package's own; `localizeIssues` rewrites it.
 */
export async function templateIssues(
  templates: TemplatesService,
  workspaceId: string,
  graph: WorkflowGraph,
): Promise<WorkflowValidationIssue[]> {
  const usable = new Map<string, Promise<boolean>>();
  const check = (ref: string) =>
    templates.resolve(workspaceId, ref).then(
      (template) => !template.row || (!template.row.archivedAt && template.row.enabled),
      () => false,
    );

  const issues: WorkflowValidationIssue[] = [];
  for (const step of graph.steps ?? []) {
    const ref = step.produces?.templateRef;
    if (ref === undefined || ref === null) continue;
    const key = typeof ref === 'string' ? ref.trim() : '';
    if (!usable.has(key)) usable.set(key, key ? check(key) : Promise.resolve(false));
    if (await usable.get(key)) continue;
    issues.push({
      stepId: step.id,
      code: 'unknownTemplate',
      params: { ref: String(ref) },
      message: `No template "${String(ref)}" in this workspace, or it is archived.`,
      severity: 'error',
    });
  }
  return issues;
}
