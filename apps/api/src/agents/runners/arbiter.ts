import type { AgentRun } from '@prisma/client';
import { type AgentFinding, type AgentRunInput, type Locale, AGENT_RUN_MAX_DOCUMENTS } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import { ProviderAccountError } from '../../assistant/assistant.client.js';
import { candidatePairs, CONTRADICTION_QUESTION, prefilterPairs, readJudgement } from '../contradiction.js';
import { wrapUntrusted } from '../../common/untrusted.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS } from '../agent-services.js';

export const arbiterRunner: AgentRunner = { key: 'arbiter', run: arbitrate };

/**
 * The arbiter (#81): contradictions between pages. The pairing is
 * deterministic — passages from different pages close enough in meaning to
 * be about the same thing (`candidatePairs`), at least one from a page that
 * changed since the last run, or the page whose indexing triggered this one.
 * The model judges each pair in one call; a judgement stands only if both
 * quotes are really in their passages (`readJudgement`). Every kept one is
 * recorded as a conflict row and mirrored as a finding, so the runs panel and
 * the conflicts views read the same thing.
 */
async function arbitrate(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  await report({ stage: 'scanning', progress: 0.05 });
  if (svc.config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'stub') {
    // The stub hashes words: every page of one product would pair with every
    // other on shared vocabulary. Not measured, and said.
    return { summary: t('agent.arbitration.stubEmbeddings'), findings: [] };
  }
  const scope = await svc.runScope(run, principal);
  const acl = await svc.permissions.documentFilterFor(scope);
  const input = (run.input ?? {}) as AgentRunInput;

  // What to re-judge: the pages the run names (a page.indexed trigger names
  // the page), else the pages whose content changed since the last arbiter
  // run that finished, else — the first run — every page.
  let inScope: Set<string> | null = input.documentIds?.length ? new Set(input.documentIds.slice(0, AGENT_RUN_MAX_DOCUMENTS)) : null;
  if (!inScope) {
    const last = await svc.prisma.agentRun.findFirst({
      where: { workspaceId: run.workspaceId, agentKey: 'arbiter', status: 'succeeded', id: { not: run.id } },
      orderBy: { finishedAt: 'desc' },
      select: { finishedAt: true },
    });
    if (last?.finishedAt) {
      const changed = await svc.prisma.documentRevision.findMany({
        where: { document: { workspaceId: run.workspaceId }, finalizedAt: { gt: last.finishedAt } },
        select: { documentId: true },
        distinct: ['documentId'],
      });
      inScope = new Set(changed.map((r) => r.documentId));
      if (inScope.size === 0) return { summary: t('agent.arbitration.nothingChanged'), findings: [] };
    }
  }

  const [chunks, relations] = await Promise.all([
    svc.graph.liveChunks(run.workspaceId, acl),
    svc.graph.getWorkspaceRelationGraph(run.workspaceId, acl),
  ]);
  const entitiesOf = new Map<string, Set<string>>();
  for (const e of relations.edges) {
    if (!entitiesOf.has(e.documentId)) entitiesOf.set(e.documentId, new Set())
    entitiesOf.get(e.documentId)!.add(e.targetKey);
  }
  const sharesEntity = (a: string, b: string) => {
    const ea = entitiesOf.get(a);
    const eb = entitiesOf.get(b);
    if (!ea || !eb) return false;
    for (const k of ea) if (eb.has(k)) return true;
    return false;
  };
  // With a decision route (#530) every candidate is screened by Jev first,
  // and the cap bounds the judge's calls rather than the candidates.
  const route = await svc.decision.routeFor(run.workspaceId);
  const cap = svc.config.get('CONTRADICTION_MAX_PAIRS_PER_RUN', { infer: true });
  const candidates = candidatePairs(chunks, inScope, {
    minSimilarity: svc.config.get('CONTRADICTION_MIN_SIMILARITY', { infer: true }),
    cap: route ? Number.POSITIVE_INFINITY : cap,
    sharesEntity,
  });
  if (candidates.length === 0) return { summary: t('agent.arbitration.noPairs'), findings: [] };

  // PG has the last word on visibility (#76), and the titles — before any
  // passage leaves for the decision model.
  const docIds = [...new Set(candidates.flatMap((p) => [p.a.documentId, p.b.documentId]))];
  const docs = await svc.prisma.document.findMany({
    where: { id: { in: docIds }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
    select: { id: true, title: true },
  });
  const titleOf = new Map(docs.map((d) => [d.id, d.title]));
  const revisionOf = (chunkId: string) => chunkId.slice(0, chunkId.lastIndexOf(':'));
  let pairs = candidates.filter((p) => titleOf.has(p.a.documentId) && titleOf.has(p.b.documentId));
  let screened: { asked: number; dropped: number } | null = null;
  if (route) {
    await report({ stage: 'screening', progress: 0.08 });
    const decision = { route, userId: run.createdBy, operation: 'contradiction' as const };
    const result = await prefilterPairs(
      pairs,
      (pair) =>
        svc.decision.noul(
          decision,
          {
            pageA: { title: titleOf.get(pair.a.documentId), passage: wrapUntrusted(pair.a.text, 'arbiter', 'page') },
            pageB: { title: titleOf.get(pair.b.documentId), passage: wrapUntrusted(pair.b.text, 'arbiter', 'page') },
          },
          CONTRADICTION_QUESTION,
        ),
      route.thresholds.arbiter,
      (error) => error instanceof ProviderAccountError,
    );
    if (result.stopped) {
      await report({ warning: t('agent.arbitration.screeningStopped', { error: (result.stopped as Error).message }) });
    }
    screened = { asked: result.asked, dropped: pairs.length - result.kept.length };
    pairs = result.kept;
  }
  pairs = pairs.slice(0, cap);

  const minConfidence = svc.config.get('CONTRADICTION_MIN_CONFIDENCE', { infer: true });
  const call = { config: agent.config, userId: run.createdBy, operation: 'contradiction' as const, locale: run.locale as Locale };
  const system = `${agent.instructions}` + (await svc.guidance(run, agent));
  const findings: AgentFinding[] = [];
  let judged = 0;
  for (const [i, pair] of pairs.entries()) {
    const titleA = titleOf.get(pair.a.documentId)!;
    const titleB = titleOf.get(pair.b.documentId)!;
    await report({ stage: 'judging', progress: 0.1 + (0.85 * i) / pairs.length });
    let raw: string;
    try {
      raw = await svc.client.chat(
        call,
        [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              `Passage A, from the page "${titleA}":\n${wrapUntrusted(pair.a.text, 'arbiter', 'page')}\n\n` +
              `Passage B, from the page "${titleB}":\n${wrapUntrusted(pair.b.text, 'arbiter', 'page')}`,
          },
        ],
        { json: true },
      );
      judged += 1;
    } catch (error) {
      // A budget refusal or a dead account is terminal for the run; anything
      // else costs one pair, not the rest.
      if (await svc.stopsPass(error, report, () => t('agent.arbitration.budgetSpent', { judged }))) break;
      svc.logger.warn(`Arbiter judgement failed for one pair: ${String(error)}`);
      continue;
    }
    const verdict = readJudgement(parseModelJson(raw), pair, minConfidence);
    if (!verdict) continue;
    const conflict = await svc.conflicts.record({
      workspaceId: run.workspaceId,
      kind: 'doc-doc',
      a: { documentId: pair.a.documentId, revisionId: revisionOf(pair.a.chunkId), chunkId: pair.a.chunkId, quote: verdict.aQuote },
      b: { documentId: pair.b.documentId, revisionId: revisionOf(pair.b.chunkId), chunkId: pair.b.chunkId, quote: verdict.bQuote },
      explanation: verdict.explanation,
      confidence: verdict.confidence,
      agentRunId: run.id,
      findingIndex: findings.length,
    });
    // Found again while open, resolved or dismissed: the row stands as it
    // was and this run has nothing new to say. New or reopened: a finding.
    if (!conflict.written) continue;
    findings.push({
      kind: 'contradiction',
      severity: 'warning',
      title: t('agent.arbitration.findingTitle', { a: titleA, b: titleB }),
      detail: `${verdict.explanation}\n\n> ${verdict.aQuote}\n\n> ${verdict.bQuote}`,
      documentIds: [pair.a.documentId, pair.b.documentId],
      documentTitles: [titleA, titleB],
      conflictId: conflict.id,
    });
    if (findings.length >= MAX_FINDINGS) break;
  }
  return {
    summary:
      t('agent.arbitration.summary', { judged, found: findings.length }) +
      (screened ? ' ' + t('agent.arbitration.screened', screened) : ''),
    findings,
  };
}
