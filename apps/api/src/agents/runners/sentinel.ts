import type { AgentRun } from '@prisma/client';
import { type AgentFinding, type AgentRunDetails, type AgentRunInput, type AgentRunPullRequest, type ApiDriftSpec, type Locale, isApiSpecKind, SOURCE_JUDGE_MAX_PAGES, sourceMisalignment } from '@knowledge/contracts';
import { headingSections } from '@knowledge/editor-schema/markdown';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { conflictFingerprint, quoteIn } from '../contradiction.js';
import { CODE_TOOLS } from '../../assistant/assistant-tool-types.js';
import { ApiDriftService, type ApiDriftResult } from '../../connectors/code-research/api-drift.service.js';
import type { ChangeImpact } from '../../components/component-usages.service.js';
import { declaredPathFixes } from '../../components/component-match.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import { visibilityWhere, type AccessScope } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { DRIFT_OUTPUT_CONTRACT, MAX_DIFF_CHARS, MAX_DRIFT_PAGES, MAX_PAGE_CHARS, MAX_SEARCHED_PAGES, affectedUsagesDetails, componentPathFinding, diffExcerpt, listOf, linkedCandidates, mentionedFiles, readDriftVerdict, readReportVerdict, reportJudgementPrompt, REPORT_OUTPUT_CONTRACT, scopeFiles, searchQueryFor, subdirOf, type DriftCandidate } from '../drift.js';
import { apiDriftFinding, apiDriftPromptNote } from '../api-drift.js';
import { MAX_CHANGE_CHARS, SOURCE_CHANGE_OUTPUT_CONTRACT, changeExcerpt, changedSections, judgeCandidates, readSourceVerdict, sourceChangePrompt, specChangedSections } from '../source-change.js';
import { readEvidence } from '../../feedback/knowledge-issues.service.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf } from '../agent-services.js';
import { destinationPages } from './archaeologist.js';

export const sentinelRunner: AgentRunner = {
  key: 'sentinel',
  // Only DriftTriggerService, KnowledgeIssuesService and SourceDependentsService
  // start one (docs/features/35): with no pull request, report or source change
  // it has nothing to check, so it has no Run button and no schedule.
  run: (svc, run, agent, principal, report) => {
    const input = (run.input ?? {}) as AgentRunInput;
    if (input.issueId) return checkReport(svc, run, agent, principal, report);
    if (input.sourceChange) return checkSourceChange(svc, run, agent, principal, report);
    if (input.apiSpecDocumentId) return checkApiDrift(svc, run, principal, report);
    return checkDrift(svc, run, agent, principal, report);
  },
};

/**
 * Checks the pages one pull or merge request may make wrong
 * (docs/features/35).
 *
 * Three stages, two of them queries. `diff` reads what the change touches
 * from the host. `related` ties pages to it without a model: the pages the
 * connector itself wrote about the changed modules, the pages under its
 * destination that name a changed file, and a few search hits for the
 * change's title — strongest tie first, capped. Only `judging` is a model:
 * one call per page, shown the page and the part of the diff that tied it,
 * returning whether a statement on it is now untrue and, when the diff says
 * enough, the corrected page.
 *
 * Nothing here writes. The corrected page rides on the finding as a draft;
 * `DriftPublishSweeper` turns it into a merge request and comments on the
 * pull request, API-side, as the connector's owner — the worker generates,
 * the API publishes.
 */
async function checkDrift(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  const pr = input.pullRequest;
  const connectorId = input.connectorId;
  if (!pr || !connectorId) throw new Error(t('error.ai.agentNeedsPullRequest', { key: agent.key }));

  // --- what the change touches
  await report({ stage: 'diff', progress: 0.05 });
  const connector = await svc.prisma.connector.findFirst({
    where: { id: connectorId, workspaceId: run.workspaceId },
    select: { id: true, name: true, kind: true, config: true, projectId: true, parentId: true },
  });
  if (!connector) throw new Error(t('error.connector.notFound', { id: connectorId }));
  const changed = await svc.pullRequests.files(connectorId, run.workspaceId, pr.number);
  if (changed.truncated) await report({ warning: t('agent.drift.truncated', { files: changed.files.length }) });
  const files = scopeFiles(changed.files, subdirOf(connector.config));
  // Spec ↔ code (#78) reads every changed file: the routes a docs
  // connector's spec describes sit outside its `subdir`.
  const api = await apiDriftForChange(svc, run, connectorId, pr, changed.files, report);
  if (files.length === 0 && !api?.specs.length) return { summary: t('agent.drift.noFiles', { number: pr.number }), findings: [] };

  // --- which pages it touches, strongest tie first
  await report({ stage: 'related', progress: 0.2 });
  const scope = await svc.runScope(run, principal);
  const apiSpecs = api ? await visibleSpecs(svc, scope, api.specs, report) : [];
  // Certain, like a path fix: static analysis, whatever the model says.
  const apiFindings = apiSpecs.map((s) => apiDriftFinding(s, pr)).filter((f): f is AgentFinding => !!f);
  const impact = files.length ? await changeImpact(svc, scope, connector, pr, files, report) : null;
  const all = files.length ? await driftCandidates(svc, scope, connector, pr, files, impact, report) : [];
  // A spec page is the repository's file: its drift is the comparison
  // above, and a model-written body would be overwritten by the next sync.
  const specIds = await specDocumentIds(svc, all.map((c) => c.documentId));
  // Past the cap a page is listed, never judged — one model call each.
  const candidates = all.filter((c) => !specIds.has(c.documentId)).slice(0, MAX_DRIFT_PAGES);

  // A declared path the change removes or moves is known from the diff
  // alone, so it is a finding whatever the model says, or whether one runs.
  const pathFindings = new Map<string, AgentFinding>();
  for (const page of impact?.declared ?? []) {
    const fixes = declaredPathFixes(page.paths, files, impact?.overlay?.baseFiles ?? null);
    if (fixes.length > 0) pathFindings.set(page.documentId, componentPathFinding({ id: page.documentId, title: page.title }, page.paths, fixes, pr));
  }
  const judged = new Set<string>();
  const details = (): AgentRunDetails | undefined => {
    const merged: AgentRunDetails = { ...affectedUsagesDetails(impact, judged), ...(apiSpecs.length ? { apiSpecs } : {}) };
    return Object.keys(merged).length ? merged : undefined;
  };

  if (candidates.length === 0) {
    const summary = apiFindings.length
      ? t('agent.drift.api.summaryPr', { number: pr.number, specs: apiSpecs.length, drifted: apiFindings.length })
      : t('agent.drift.noRelated', { number: pr.number, files: files.length });
    return { summary, findings: [...apiFindings, ...pathFindings.values()], details: details() };
  }

  // 'tools' is a preference, not a prerequisite — the curator's rule.
  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  if (!agent.config.enabled || blocking.length > 0) {
    // No model: the ties are still facts worth a reader's attention, so the
    // strong ones become heads-up findings with no verdict and no draft. A
    // search hit is not strong enough to say anything about without reading.
    await report({ warning: t('agent.drift.noModel') });
    const findings: AgentFinding[] = candidates
      .filter((c) => c.tie !== 'searched')
      .map(
        (c) =>
          pathFindings.get(c.documentId) ?? {
            kind: 'stale',
            severity: 'info',
            title: t('agent.drift.mayDriftTitle', { title: c.title }),
            detail: t('agent.drift.mayDriftDetail', { number: pr.number, files: c.files.slice(0, 5).join(', ') }),
            documentIds: [c.documentId],
            documentTitles: [c.title],
          },
      );
    for (const [documentId, finding] of pathFindings) {
      if (!candidates.some((c) => c.documentId === documentId)) findings.push(finding);
    }
    findings.unshift(...apiFindings);
    return {
      summary: t('agent.drift.summaryNoModel', { number: pr.number, pages: findings.length }),
      findings,
      details: details(),
    };
  }

  // --- the judgement: one call per page
  const skills = await svc.guidance(run, agent);
  const call = {
    config: agent.config,
    userId: run.createdBy,
    operation: 'agent' as const,
    locale: run.locale as Locale,
  };
  const tools = [...svc.readTools.definitions(), ...svc.code.definitions()];
  const toolCtx = svc.toolCtx(run, principal);
  // The run reads one repository, whatever connectorId the model writes —
  // the archaeologist's rule. The code tools read the connector's branch, not
  // the change; the change itself is in the prompt.
  const execute = (name: string, args: Record<string, unknown>) =>
    CODE_TOOLS.has(name)
      ? svc.code.execute(name, { ...args, connectorId }, toolCtx)
      : svc.readTools.execute(name, args, toolCtx);
  const byPath = new Map(files.map((f) => [f.path, f]));
  const apiNote = apiDriftPromptNote(apiSpecs);

  const findings: AgentFinding[] = [];
  let checked = 0;
  for (const [at, candidate] of candidates.entries()) {
    await report({ stage: 'judging', progress: 0.3 + (0.65 * at) / candidates.length });
    const content = await svc.documents.getContent(candidate.documentId).catch(() => null);
    if (!content || !content.markdown.trim()) continue;

    // A searched page has no file of its own to be shown; it sees the change.
    const shown = candidate.files.length
      ? candidate.files.map((p) => byPath.get(p)).filter((f): f is (typeof files)[number] => !!f)
      : files;
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}

${DRIFT_OUTPUT_CONTRACT}${skills}` },
      {
        role: 'user',
        content:
          `Repository: ${connector.name}. Code tools read its configured branch, which does NOT yet contain ` +
          `this change; connectorId is ${connectorId}.

` +
          `Change #${pr.number}${pr.headRef ? ` (${pr.headRef} → ${pr.baseRef ?? '?'})` : ''}, not merged yet.
` +
          `Why this page may be affected: ${candidate.reasons.join('; ')}.

` +
          wrapUntrusted(
            `Title: ${pr.title}

${diffExcerpt(shown, MAX_DIFF_CHARS)}`,
            'pull_request',
            'repo',
          ) +
          `

<page title=${JSON.stringify(candidate.title)} documentId="${candidate.documentId}">
` +
          `${content.markdown.slice(0, MAX_PAGE_CHARS)}
</page>` +
          apiNote,
      },
    ];

    try {
      const raw = await svc.callModel(call, agent, messages, execute, tools);
      checked += 1;
      judged.add(candidate.documentId);
      const verdict = parseModelJson(raw);
      const finding = readDriftVerdict(
        verdict,
        { id: candidate.documentId, title: candidate.title, markdown: content.markdown },
        pr,
      );
      // #81: a drifted page is a doc↔code conflict too. Its identity is the
      // page and the pull request, so every push re-judges one row. The
      // claim is the page's own sentence when the model quoted one that is
      // really there, else the finding's title. Non-fatal: the finding stands.
      if (finding) {
        const quoted = typeof verdict?.quote === 'string' && quoteIn(content.markdown, verdict.quote) ? verdict.quote.trim() : null;
        const conflict = await svc.conflicts
          .record({
            workspaceId: run.workspaceId,
            kind: 'doc-code',
            a: { documentId: candidate.documentId, revisionId: content.revisionId, chunkId: null, quote: (quoted ?? finding.title).slice(0, 1_000) },
            b: null,
            codeRef: {
              connectorId,
              repository: connector.name,
              pullRequestNumber: pr.number,
              pullRequestUrl: pr.url,
              headSha: pr.headSha,
              paths: candidate.files.slice(0, 20),
            },
            fingerprint: conflictFingerprint([{ documentId: candidate.documentId, quote: `pr:${connectorId}#${pr.number}` }]),
            refreshOpen: true,
            explanation: finding.detail,
            // The sentinel's verdict carries no score; a drift it reports is one it asserts.
            confidence: 1,
            agentRunId: run.id,
            findingIndex: null,
          })
          .catch((e) => {
            svc.logger.warn(`Sentinel could not record a conflict for "${candidate.title}": ${String(e)}`);
            return null;
          });
        if (conflict) finding.conflictId = conflict.id;
      }
      // One finding per page, so one merge request: the path edit rides on
      // the corrected body when the model wrote one.
      const paths = pathFindings.get(candidate.documentId);
      if (finding && paths) {
        pathFindings.delete(candidate.documentId);
        findings.push({ ...finding, detail: `${paths.detail} ${finding.detail}`.slice(0, 2_000), componentPaths: paths.componentPaths });
      } else if (finding) findings.push(finding);
    } catch (error) {
      if (await svc.stopsPass(error, report, () => t('agent.drift.budgetSpent', { checked, pages: candidates.length }))) break;
      svc.logger.warn(`Sentinel could not judge "${candidate.title}": ${String(error)}`);
      await report({ warning: t('agent.warning.pageNotReviewed', { title: candidate.title, error: reasonOf(error) }) });
    }
  }

  // Path and spec findings first: they are certain, and the cap must not drop them.
  findings.unshift(...apiFindings, ...pathFindings.values());
  return {
    summary: t('agent.drift.summary', {
      number: pr.number,
      files: files.length,
      pages: t('agent.count.pages', { count: checked }),
      drifted: findings.length,
    }),
    findings: findings.slice(0, MAX_FINDINGS),
    details: details(),
  };
}

/**
 * What a change does to the agreement between the repository's specs and
 * its routes (#78, phase 8), or null when it ties no spec. Any failure costs
 * the comparison, never the run — the pages are still worth judging.
 */
async function apiDriftForChange(
  svc: AgentServices,
  run: AgentRun,
  connectorId: string,
  pr: AgentRunPullRequest,
  changed: Parameters<ApiDriftService['forPullRequest']>[3],
  report: AgentReporter,
): Promise<ApiDriftResult | null> {
  try {
    const result = await svc.apiDrift.forPullRequest(connectorId, run.workspaceId, pr.headSha, changed, run.locale as Locale);
    for (const warning of result?.warnings ?? []) await report({ warning });
    return result;
  } catch (error) {
    svc.logger.warn(`Sentinel could not compare specs with routes for #${pr.number}: ${String(error)}`);
    await report({ warning: t('agent.drift.api.failed') });
    return null;
  }
}

/** The specs the run's audience may open; the rest are counted, never named. */
async function visibleSpecs(svc: AgentServices, scope: AccessScope, specs: ApiDriftSpec[], report: AgentReporter): Promise<ApiDriftSpec[]> {
  const visible = await svc.permissions.visibleDocumentIds(scope, specs.map((s) => s.documentId));
  const hidden = specs.filter((s) => !visible.has(s.documentId)).length;
  if (hidden > 0) await report({ warning: t('agent.drift.api.hidden', { count: hidden }) });
  return specs.filter((s) => visible.has(s.documentId));
}

/** Which of these pages are spec documents. */
async function specDocumentIds(svc: AgentServices, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await svc.prisma.document.findMany({
    where: { id: { in: ids }, kind: { in: ['openapi', 'asyncapi'] } },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * The on-demand spec ↔ code check (#78, phase 8): one spec against its
 * repository's default branch, with no pull request and no model — the
 * comparison is static analysis, so it runs whether or not a model is
 * configured. Everything it finds is reported, drift that predates any
 * change included; the result is the run's findings, the same surface as a
 * pull request check, and nothing is published.
 */
async function checkApiDrift(svc: AgentServices, run: AgentRun, principal: Principal, report: AgentReporter): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  const documentId = input.apiSpecDocumentId;
  if (!documentId || !input.connectorId) throw new Error(t('agent.drift.api.needsSpec'));

  await report({ stage: 'routes', progress: 0.1 });
  const scope = await svc.runScope(run, principal);
  if (!(await svc.permissions.visibleDocumentIds(scope, [documentId])).has(documentId)) {
    throw new Error(t('agent.drift.api.restricted'));
  }
  const result = await svc.apiDrift.forBranch(input.connectorId, run.workspaceId, documentId, run.locale as Locale);
  for (const warning of result.warnings) await report({ warning });
  const spec = result.specs[0];
  if (!spec) return { summary: t('agent.drift.api.summaryUnchecked'), findings: [] };

  await report({ stage: 'comparing', progress: 0.9 });
  const details: AgentRunDetails = { apiSpecs: [spec] };
  if (spec.routes === 0) return { summary: t('agent.drift.api.summaryNoRoutes', { title: spec.title }), findings: [], details };
  const finding = apiDriftFinding(spec, null);
  return {
    summary: finding
      ? t('agent.drift.api.summaryDrifted', { title: spec.title, count: spec.mismatchTotal, routes: spec.routes })
      : t('agent.drift.api.summaryClean', { title: spec.title, routes: spec.routes }),
    findings: finding ? [finding] : [],
    details,
  };
}

/**
 * The component pages a change touches and the pages documenting where that
 * code is used (#236), or null when it touches none. The head's imports of
 * the changed files are read only once a declaration is known to be
 * touched; any failure costs the two new ties, never the run.
 */
async function changeImpact(
  svc: AgentServices,
  scope: AccessScope,
  connector: { id: string; kind: string },
  pr: NonNullable<AgentRunInput['pullRequest']>,
  files: ReturnType<typeof scopeFiles>,
  report: AgentReporter,
): Promise<ChangeImpact | null> {
  if (connector.kind !== 'codebase') return null;
  try {
    return await svc.componentUsages.forChange(scope, connector.id, files, async () => {
      try {
        const head = await svc.pullRequests.headImports(connector.id, scope.workspaceId, pr.headSha, files);
        if (head.unread > 0) await report({ warning: t('agent.drift.overlayPartial', { files: head.unread }) });
        return head;
      } catch (error) {
        svc.logger.warn(`Sentinel could not read the head of #${pr.number}: ${String(error)}`);
        await report({ warning: t('agent.drift.overlayFailed') });
        return null;
      }
    });
  } catch (error) {
    svc.logger.warn(`Sentinel could not find component usages for #${pr.number}: ${String(error)}`);
    await report({ warning: t('agent.drift.usagesFailed') });
    return null;
  }
}

/**
 * The sentinel pointed at a report instead of a diff (docs/features/38,
 * phase 3): one page, one model call, the report's text wrapped as the
 * untrusted evidence it is. The verdict is a `stale` finding naming the
 * report, with the corrected page as a draft when the model is sure; no
 * finding means the report was judged wrong, and `ReportPublishSweeper`
 * resolves the issue. The worker writes nothing else.
 */
async function checkReport(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const issueId = ((run.input ?? {}) as AgentRunInput).issueId;
  if (!issueId) throw new Error(t('error.ai.agentNeedsPullRequest', { key: agent.key }));

  await report({ stage: 'report', progress: 0.05 });
  const issue = await svc.prisma.knowledgeIssue.findFirst({ where: { id: issueId, workspaceId: run.workspaceId } });
  if (!issue) throw new Error(t('error.knowledgeIssue.notFound', { id: issueId }));
  const page = await svc.prisma.document.findFirst({
    where: { id: issue.documentId, workspaceId: run.workspaceId },
    select: { id: true, title: true },
  });
  if (!page) throw new Error(t('error.document.notFound', { id: issue.documentId }));
  // A failure, not an empty verdict: the publisher reads "no finding" as
  // "judged wrong" and would resolve the report. A failed run sends it back
  // to `open` with this note, in front of a person who can open the page.
  const scope = await svc.runScope(run, principal);
  if (!(await svc.permissions.visibleDocumentIds(scope, [page.id])).has(page.id)) {
    throw new Error(t('agent.report.restricted'));
  }
  const head = await svc.documents.getContent(page.id).catch(() => null);
  if (!head || !head.markdown.trim()) {
    return { summary: t('agent.report.noContent', { title: page.title }), findings: [] };
  }
  const reported =
    issue.revisionId && issue.revisionId !== head.revisionId
      ? await svc.documents
          .getContent(page.id, issue.revisionId)
          .then((c) => ({ revisionId: c.revisionId, markdown: c.markdown }))
          .catch(() => null)
      : null;

  const echo: AgentFinding = {
    kind: 'stale',
    severity: 'info',
    title: t('agent.report.reportedTitle', { title: page.title, kind: issue.kind }),
    detail: issue.detail.slice(0, 2_000),
    documentIds: [page.id],
    documentTitles: [page.title],
    issueId: issue.id,
  };
  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  if (!agent.config.enabled || blocking.length > 0) {
    // No model: the report is still worth a reader's attention, so it is
    // echoed as a heads-up finding with no verdict — `agent.drift.noModel`.
    await report({ warning: t('agent.report.noModel') });
    return { summary: t('agent.report.summaryNoModel', { title: page.title }), findings: [echo] };
  }

  await report({ stage: 'judging', progress: 0.4 });
  const skills = await svc.guidance(run, agent);
  const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
  const tools = svc.readTools.definitions();
  const toolCtx = svc.toolCtx(run, principal);
  const execute = (name: string, args: Record<string, unknown>) => svc.readTools.execute(name, args, toolCtx);
  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: `${agent.instructions}\n\n${REPORT_OUTPUT_CONTRACT}${skills}` },
    {
      role: 'user',
      content: reportJudgementPrompt(
        {
          id: issue.id,
          kind: issue.kind,
          detail: issue.detail,
          evidence: readEvidence(issue.evidence),
          suggestedMarkdown: issue.suggestedMarkdown,
          reportCount: issue.reportCount,
        },
        { id: page.id, title: page.title, markdown: head.markdown },
        reported,
        MAX_PAGE_CHARS,
      ),
    },
  ];

  try {
    const raw = await svc.callModel(call, agent, messages, execute, tools);
    const finding = readReportVerdict(parseModelJson(raw), { id: page.id, title: page.title, markdown: head.markdown }, issue.id);
    return {
      summary: finding
        ? t('agent.report.summaryConfirmed', { title: page.title, drafted: finding.draft ? 1 : 0 })
        : t('agent.report.summaryRejected', { title: page.title }),
      findings: finding ? [finding] : [],
    };
  } catch (error) {
    if (!(await svc.stopsPass(error, report))) {
      svc.logger.warn(`Sentinel could not judge report ${issue.id}: ${String(error)}`);
      await report({ warning: t('agent.warning.pageNotReviewed', { title: page.title, error: reasonOf(error) }) });
    }
    // Not judged is not "judged fine": the echo keeps the report in front of
    // a person, and the publisher reads an info finding as exactly that.
    return { summary: t('agent.report.summaryNoModel', { title: page.title }), findings: [echo] };
  }
}

/**
 * The sentinel pointed at a source-backed page's new version (#674, phase
 * 5b): the pages linking it, judged against only what changed.
 *
 * `diff` reads the changed sections — heading sections, or a spec's changed
 * operations under their anchors. `related` keeps the linking pages a change
 * can concern (`judgeCandidates`) and drops those already flagged (the
 * deterministic pass ran first; in `propose` mode the pages it flagged stay,
 * for their fix), archived or source-backed. A page the
 * workspace audience cannot read is not judged, and neither is one past
 * `SOURCE_JUDGE_MAX_PAGES`: both go to `details.sourceUnchecked`, which the
 * publisher flags "not checked". `judging` is one model call per page.
 *
 * Nothing here writes: `SourceChangePublishSweeper` flags the pages and, in
 * `propose` mode, opens the drafted fixes — API-side, as the run's owner.
 */
async function checkSourceChange(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const change = ((run.input ?? {}) as AgentRunInput).sourceChange!;

  await report({ stage: 'diff', progress: 0.05 });
  const source = await svc.prisma.document.findFirst({
    where: { id: change.documentId, workspaceId: run.workspaceId },
    select: { id: true, title: true, kind: true },
  });
  if (!source) throw new Error(t('error.document.notFound', { id: change.documentId }));
  const link = await svc.prisma.connectorLink.findFirst({
    where: { documentId: source.id, connector: { kind: 'web' } },
    select: { externalUrl: true, externalId: true, connector: { select: { config: true } } },
  });
  // In `propose` mode the pages the deterministic pass flagged are judged
  // too: the flag is certain, the fix is what is missing.
  const proposing = new Set(sourceMisalignment(link?.connector.config) === 'propose' ? (change.flagged ?? []) : []);
  const origin = { title: source.title, url: link?.externalUrl ?? link?.externalId ?? '' };
  const sections = isApiSpecKind(source.kind)
    ? specChangedSections((await svc.specDiff.diff(source.id, change.fromRevisionId, change.toRevisionId))?.changes ?? [])
    : changedSections(
        headingSections((await svc.documents.getContent(source.id, change.fromRevisionId)).markdown),
        headingSections((await svc.documents.getContent(source.id, change.toRevisionId)).markdown),
      );
  if (sections.length === 0) return { summary: t('agent.sourceChange.noChange', { title: source.title }), findings: [] };

  await report({ stage: 'related', progress: 0.2 });
  const links = await svc.prisma.pageLink.findMany({
    where: { workspaceId: run.workspaceId, targetDocumentId: source.id, sourceDocumentId: { not: source.id } },
    select: { sourceDocumentId: true, targetAnchor: true },
  });
  const all = judgeCandidates(links, new Set(sections.map((s) => s.id)));
  const ids = all.map((c) => c.documentId);
  const [open, sourced] = await Promise.all([
    svc.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId: run.workspaceId, archivedAt: null },
      select: { id: true, title: true, verificationFlag: true },
    }),
    svc.prisma.connectorLink.findMany({ where: { documentId: { in: ids }, connector: { kind: 'web' } }, select: { documentId: true } }),
  ]);
  // Already asked about is skipped — unless the pass asked and a fix is wanted.
  const titles = new Map(
    open.filter((d) => d.verificationFlag === null || (d.verificationFlag === 'requested' && proposing.has(d.id))).map((d) => [d.id, d.title]),
  );
  const sourceBacked = new Set(sourced.map((l) => l.documentId));
  const live = all.filter((c) => titles.has(c.documentId) && !sourceBacked.has(c.documentId));
  const visible = await svc.permissions.visibleDocumentIds(await svc.runScope(run, principal), live.map((c) => c.documentId));
  const readable = live.filter((c) => visible.has(c.documentId));
  const unchecked: NonNullable<AgentRunDetails['sourceUnchecked']> = [
    ...live.filter((c) => !visible.has(c.documentId)).map((c) => ({ documentId: c.documentId, reason: 'restricted' as const })),
    ...readable.slice(SOURCE_JUDGE_MAX_PAGES).map((c) => ({ documentId: c.documentId, reason: 'cap' as const })),
  ];
  const candidates = readable.slice(0, SOURCE_JUDGE_MAX_PAGES);
  const details: AgentRunDetails | undefined = unchecked.length ? { sourceUnchecked: unchecked } : undefined;
  if (candidates.length === 0) return { summary: t('agent.sourceChange.noRelated', { title: source.title }), findings: [], details };

  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  if (!agent.config.enabled || blocking.length > 0) {
    // Queued with a model that has since gone: nothing judged, nothing claimed.
    return { summary: t('agent.sourceChange.noModel', { title: source.title }), findings: [], details };
  }

  const skills = await svc.guidance(run, agent);
  const call = { config: agent.config, userId: run.createdBy, operation: 'source-judge' as const, locale: run.locale as Locale };
  const tools = svc.readTools.definitions();
  const toolCtx = svc.toolCtx(run, principal);
  const execute = (name: string, args: Record<string, unknown>) => svc.readTools.execute(name, args, toolCtx);

  const findings: AgentFinding[] = [];
  let checked = 0;
  for (const [at, candidate] of candidates.entries()) {
    const title = titles.get(candidate.documentId)!;
    await report({ stage: 'judging', progress: 0.3 + (0.65 * at) / candidates.length });
    const content = await svc.documents.getContent(candidate.documentId).catch(() => null);
    if (!content || !content.markdown.trim()) continue;
    const page = { id: candidate.documentId, title, markdown: content.markdown };
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}\n\n${SOURCE_CHANGE_OUTPUT_CONTRACT}${skills}` },
      { role: 'user', content: sourceChangePrompt(origin, changeExcerpt(sections, candidate.anchors, MAX_CHANGE_CHARS), page, MAX_PAGE_CHARS) },
    ];
    try {
      const raw = await svc.callModel(call, agent, messages, execute, tools);
      checked += 1;
      const finding = readSourceVerdict(parseModelJson(raw), page, origin);
      if (finding) findings.push(finding);
    } catch (error) {
      if (await svc.stopsPass(error, report, () => t('agent.drift.budgetSpent', { checked, pages: candidates.length }))) break;
      svc.logger.warn(`Sentinel could not judge "${title}" against ${source.id}: ${String(error)}`);
      await report({ warning: t('agent.warning.pageNotReviewed', { title, error: reasonOf(error) }) });
    }
  }
  return {
    summary: t('agent.sourceChange.summary', { title: source.title, pages: t('agent.count.pages', { count: checked }), drifted: findings.length }),
    findings: findings.slice(0, MAX_FINDINGS),
    details,
  };
}

/**
 * The pages a change is tied to, and why, strongest first and uncapped — the
 * caller judges the first `MAX_DRIFT_PAGES`. Each tie is a weaker claim than
 * the one before: a page declared the changed file as its component (#236),
 * the connector wrote a page about exactly that code, a page documents code
 * that uses a changed component, a person named the file, and last, a page
 * merely reads like the change's title.
 */
async function driftCandidates(
  svc: AgentServices,
  scope: AccessScope,
  connector: { id: string; kind: string; projectId: string; parentId: string | null },
  pr: NonNullable<AgentRunInput['pullRequest']>,
  files: ReturnType<typeof scopeFiles>,
  impact: ChangeImpact | null,
  report: AgentReporter,
): Promise<DriftCandidate[]> {
  const workspaceId = scope.workspaceId;
  const links = await svc.prisma.connectorLink.findMany({
    where: { connectorId: connector.id },
    select: { externalId: true, documentId: true },
  });
  const { ties, inChange } = linkedCandidates(connector.kind, links, files);
  const out = new Map<string, DriftCandidate>();

  // `impact` was read under `scope` already: every page in it may be opened.
  for (const page of impact?.declared ?? []) {
    out.set(page.documentId, {
      documentId: page.documentId,
      title: page.title,
      tie: 'declared',
      reasons: [`declares ${listOf(page.files)} in component.paths`],
      files: page.files,
    });
  }

  const titles = new Map(
    (
      await svc.prisma.document.findMany({
        where: { id: { in: [...ties.keys()] }, workspaceId, AND: [visibilityWhere(scope)] },
        select: { id: true, title: true },
      })
    ).map((d) => [d.id, d.title]),
  );
  for (const [documentId, tie] of ties) {
    const title = titles.get(documentId);
    if (title && !out.has(documentId)) out.set(documentId, { documentId, title, tie: 'linked', ...tie });
  }

  for (const page of impact?.affected ?? []) {
    if (out.has(page.documentId) || inChange.has(page.documentId)) continue;
    out.set(page.documentId, {
      documentId: page.documentId,
      title: page.title,
      tie: 'used',
      reasons: [`documents ${listOf(page.sites)}, which use${page.sites.length === 1 ? 's' : ''} ${listOf(page.uses)} (changed)`],
      files: page.uses,
    });
  }

  for (const page of await destinationPages(svc, scope, connector)) {
    if (inChange.has(page.id) || out.has(page.id)) continue;
    const named = mentionedFiles(`${page.title}
${page.markdown}`, files);
    if (named.length === 0) continue;
    out.set(page.id, {
      documentId: page.id,
      title: page.title,
      tie: 'mentioned',
      reasons: [`names ${named.slice(0, 3).join(', ')}${named.length > 3 ? ` and ${named.length - 3} more` : ''}`],
      files: named,
    });
  }

  // A page outside the connector's destination — a hand-written design doc —
  // is the one most likely to drift and least likely to be tied above. One
  // search, few hits; a failure costs the weakest tie, never the run.
  // Not filed in the analytics log (#79): a query built from a PR's files is
  // nobody's question, like a backtest replay.
  try {
    const res = await svc.search.search(
      {
        workspaceId,
        query: searchQueryFor(pr, files),
        mode: 'hybrid',
        limit: MAX_SEARCHED_PAGES * 3,
      },
      scope,
    );
    let added = 0;
    for (const hit of res.results) {
      if (added >= MAX_SEARCHED_PAGES) break;
      if (out.has(hit.documentId) || inChange.has(hit.documentId)) continue;
      out.set(hit.documentId, {
        documentId: hit.documentId,
        title: hit.title,
        tie: 'searched',
        reasons: ['reads like the change (search)'],
        files: [],
      });
      added += 1;
    }
  } catch (error) {
    svc.logger.warn(`Sentinel search failed: ${String(error)}`);
    await report({ warning: t('agent.drift.searchFailed') });
  }

  return [...out.values()];
}
