import type { AgentRun } from '@prisma/client';
import type { AgentRunInput, Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { LINT_TEXT_MAX, enabledRules, lintMessages, readLintViolations } from '../lint.js';
import { changedText, styleFindings } from '../../documents/lint/lint-check.js';
import { parseModelJson } from '../../common/model-json.js';
import type { AgentServices, AgentRunner, AgentReporter, AgentRunResult } from '../agent-services.js';

export const linterRunner: AgentRunner = { key: 'linter', run: lintMergeRequest };

/**
 * The style lint of one merge request head (#74, phase 2).
 *
 * Only what the merge request adds is linted: the merge-base diff's added
 * lines, so a violation already on the target is not this author's. A page's
 * first merge request has no target head, and then all of it is new. The
 * prompt and the gate on what comes back are `lint.ts`'s, the same ones the
 * editor's check uses; `styleFindings` then keeps only quotes the page holds
 * and anchors each to the head. The run publishes nothing — the API's
 * `LintPublishSweeper` turns its findings into threads.
 */
async function lintMergeRequest(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const lint = ((run.input ?? {}) as AgentRunInput).lint;
  if (!lint) throw new Error(t('agent.lint.noInput'));
  if (!agent.config.enabled || agent.missing.length > 0) throw new Error(t('agent.lint.cannotRun'));

  // Asked again on execution, not only at enqueue: the page may have been
  // restricted since, and this run's findings are listed to every member.
  // The page is the head's (#636: a merge request spans pages, one check each).
  const scope = await svc.runScope(run, principal);
  const head = await svc.prisma.documentRevision.findUnique({ where: { id: lint.headRevisionId }, select: { documentId: true } });
  const mr =
    head &&
    (await svc.prisma.mergeRequest.findFirst({
      where: { id: lint.mergeRequestId, document: { workspaceId: run.workspaceId } },
      include: { targetBranch: { select: { name: true } } },
    }));
  const doc =
    mr &&
    (await svc.prisma.document.findFirst({
      where: { id: head.documentId, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
      select: { id: true, title: true, projectId: true },
    }));
  if (!mr || !doc) throw new Error(t('agent.lint.notVisible'));

  const styleguide = await svc.skills.effectiveStyleguide(run.workspaceId, doc.projectId);
  if (!styleguide || enabledRules(styleguide.rules).length === 0) {
    return { summary: t('agent.lint.noStyleguide'), findings: [] };
  }
  svc.trust(run, JSON.stringify(styleguide.rules));

  await report({ stage: 'diff' });
  const target = (
    await svc.prisma.documentBranch.findUnique({
      where: { documentId_name: { documentId: doc.id, name: mr.targetBranch.name } },
      select: { headRevisionId: true },
    })
  )?.headRevisionId;
  const diff = target
    ? await svc.compare.compare(doc.id, target, lint.headRevisionId, 'merge-base', { structural: false })
    : await svc.compare.compareWithNothing(doc.id, lint.headRevisionId, { structural: false });
  const text = changedText(diff.hunks).slice(0, LINT_TEXT_MAX);
  if (!text.trim()) return { summary: t('agent.lint.nothingChanged'), findings: [] };

  await report({ stage: 'linting' });
  const raw = await svc.client.chat(
    { config: agent.config, userId: principal.userId, operation: 'lint', locale: run.locale as Locale },
    lintMessages(agent.instructions, styleguide.rules, doc.title, text),
    { json: true },
  );
  const max = svc.config.get('LINT_MAX_FINDINGS', { infer: true });
  const { violations, dropped } = readLintViolations(parseModelJson(raw), styleguide.rules, text, max);
  const page = await svc.documents.getContent(doc.id, lint.headRevisionId);
  const findings = styleFindings(violations, styleguide.rules, {
    documentId: doc.id,
    title: doc.title,
    revisionId: lint.headRevisionId,
    markdown: page.markdown,
    changed: text,
  });
  const ungrounded = dropped + violations.length - findings.length;
  if (ungrounded > 0) await report({ warning: t('agent.lint.dropped', { count: ungrounded }) });

  return {
    summary:
      findings.length === 0
        ? t('agent.lint.clean')
        : t('agent.lint.summary', { violations: t('agent.count.violations', { count: findings.length }) }),
    findings,
  };
}
