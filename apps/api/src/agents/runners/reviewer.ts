import type { AgentRun } from '@prisma/client';
import type { AgentFinding, Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf, pageScope, runBrief } from '../agent-services.js';
import { wrapUntrusted } from '../../common/untrusted.js';

/** Pages the reviewer reads in one pass — one model call each, so this is the cost. */
const MAX_REVIEWED = 8;

/** How much of a page the reviewer is shown. */
const MAX_REVIEW_CHARS = 40_000;

/** Issues taken from one page, so a single bad page cannot fill the run. */
const MAX_ISSUES_PER_PAGE = 5;

export const reviewerRunner: AgentRunner = { key: 'reviewer', run: review };

/**
 * Reviews the pages that changed most recently — or the run's named pages
 * (#70) — one model call each.
 *
 * The same division of labour as the curator: *which* pages changed is a
 * query, so the worker answers it, and the model is spent only on reading
 * them. Naturally bounded by `take` — a review pass is per page, so the cost
 * is linear and the cap is the budget.
 */
async function review(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  if (!agent.config.enabled || agent.missing.length > 0) {
    throw new Error(t('agent.review.cannotRun'));
  }

  // Newest revision first, then back to the page — "recently changed" is a
  // fact about revisions, and `documents` carries no updatedAt.
  const scope = await svc.runScope(run, principal);
  const recent = await svc.prisma.documentRevision.findMany({
    where: {
      document: { workspaceId: run.workspaceId, ...pageScope(run), AND: [visibilityWhere(scope)] },
      status: 'indexed',
    },
    distinct: ['documentId'],
    orderBy: { createdAt: 'desc' },
    select: { documentId: true, createdAt: true },
    take: MAX_REVIEWED,
  });
  if (recent.length === 0) return { summary: t('agent.review.noPages'), findings: [] };

  const documents = await svc.prisma.document.findMany({
    where: { id: { in: recent.map((r) => r.documentId) } },
    select: { id: true, title: true },
  });
  const byId = new Map(documents.map((d) => [d.id, d]));
  const skillText = await svc.guidance(run, agent);

  const findings: AgentFinding[] = [];
  let reviewed = 0;
  for (const [at, row] of recent.entries()) {
    if (findings.length >= MAX_FINDINGS) break;
    const doc = byId.get(row.documentId);
    if (!doc) continue;
    // One model call per page, so this loop is the run's whole duration and
    // the one place it can honestly say how far in it is. It is also why the
    // heartbeat matters here most: eight pages against a slow provider
    // outlives the sweeper's 30-minute patience (docs/features/29).
    await report({ stage: 'reviewing', progress: at / recent.length });
    const content = await svc.documents.getContent(doc.id).catch(() => null);
    if (!content || !content.markdown.trim()) continue;

    try {
      const raw = await svc.client.chat(
        {
          config: agent.config,
          userId: principal.userId,
          operation: 'agent',
          locale: run.locale as Locale,
        },
        [
          { role: 'system', content: agent.instructions + skillText },
          {
            role: 'user',
            // The page is DATA (#1102): title and body through the one wrapper.
            content: `${runBrief(run.input)}${wrapUntrusted(`Title: ${doc.title}\n\n${content.markdown.slice(0, MAX_REVIEW_CHARS)}`, 'review_page', 'document')}`,
          },
        ],
        { json: true },
      );
      reviewed++;
      for (const finding of readIssues(raw, doc)) {
        findings.push(finding);
        if (findings.length >= MAX_FINDINGS) break;
      }
    } catch (error) {
      // The provider refused the account (no credit, bad key): every later
      // page would fail identically, so one warning, not one per page.
      if (await svc.stopsPass(error, report)) break;
      // One unreadable page must not lose the pages already reviewed — but a
      // pass that silently skipped half its pages reads as a clean review.
      svc.logger.warn(`Reviewer could not review "${doc.title}": ${String(error)}`);
      await report({ warning: t('agent.warning.pageNotReviewed', { title: doc.title, error: reasonOf(error) }) });
    }
  }

  return {
    // Counts are translated by a nested t() rather than glued in as
    // `page(s)`: Russian declines the noun, so the number and its noun
    // travel together (docs/features/18).
    summary:
      reviewed === 0
        ? t('agent.review.none')
        : t('agent.review.summary', {
            pages: t('agent.count.pages', { count: reviewed }),
            issues: t('agent.count.issues', { count: findings.length }),
          }),
    findings,
  };
}

/**
 * The reviewer speaks in `issues`, not findings — it is the same prompt the
 * editor's review panel uses, and rewriting it for the background would give
 * one agent two voices. Translated here instead; severity maps across, and
 * the citation is the page under review, so a finding is never uncited.
 */
function readIssues(raw: string, doc: { id: string; title: string }): AgentFinding[] {
  const parsed = parseModelJson(raw);
  const issues = Array.isArray(parsed?.issues) ? (parsed.issues as unknown[]) : [];
  const out: AgentFinding[] = [];
  for (const entry of issues) {
    if (!entry || typeof entry !== 'object') continue;
    const issue = entry as Record<string, unknown>;
    const message = typeof issue.message === 'string' ? issue.message.trim() : '';
    if (!message) continue;
    const section = typeof issue.section === 'string' && issue.section.trim() ? issue.section.trim() : null;
    out.push({
      kind: 'other',
      severity: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
      title: `${doc.title}${section ? ` — ${section}` : ''}`,
      detail: message.slice(0, 2_000),
      documentIds: [doc.id],
      documentTitles: [doc.title],
    });
    if (out.length >= MAX_ISSUES_PER_PAGE) break;
  }
  return out;
}
