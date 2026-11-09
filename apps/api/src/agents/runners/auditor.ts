import { Prisma, type AgentRun } from '@prisma/client';
import { type AgentFinding, type AgentRunInput, type Locale, buildPageRefResolver, type PageRefResolver, type QualityDimensionScores, type QualityDuplicate, type QualityIssue, type StyleRule } from '@knowledge/contracts';
import { LISTED_PAGE } from '../../common/listed-page.js';
import { t } from '../../i18n/t.js';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { RUBRIC_VERSION, auditMessages, duplicatePeers, duplicationCheck, emptyDimensions, isDue, linkCheck, overallScore, ownershipCheck, readModelHalf, reusableModelHalf, styleguideHash, type ModelHalf, type PriorScore } from '../quality.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, MAX_FINDINGS, reasonOf } from '../agent-services.js';

/** Pages the auditor compares the audited ones with for near-duplicates — the most recently active. */
const MAX_COMPARED = 1_000;

export const auditorRunner: AgentRunner = { key: 'auditor', run: audit };

/**
 * Scores every page that is due (#74, phase 4) and stores one
 * `document_quality_scores` row each.
 *
 * Due means never scored, changed since, scored under an older rubric or
 * another styleguide, or scored longer ago than the audit interval. Links,
 * ownership and near-duplicates are facts and are recomputed every time; the
 * model half (clarity, completeness, style) is one call per page, reused when
 * the stored row already judged this revision against these rules — so a run
 * over an unchanged corpus makes no model call. With no model the facts are
 * still written, the judgements null.
 *
 * The rows are written here, in the worker: a score is a measurement, like
 * the run's own findings, and attributes no act to a person. The findings
 * are only the actionable tail — near-duplicate pairs and pages below the
 * threshold or with broken links.
 */
async function audit(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  await report({ stage: 'scanning', progress: 0.02 });
  const scope = await svc.runScope(run, principal);
  const pages = await svc.prisma.document.findMany({
    where: {
      workspaceId: run.workspaceId,
      kind: 'page',
      archivedAt: null,
      ...LISTED_PAGE,
      AND: [visibilityWhere(scope)],
    },
    select: {
      id: true,
      title: true,
      projectId: true,
      ownerId: true,
      defaultBranch: true,
      branches: { select: { name: true, headRevisionId: true } },
    },
    orderBy: { lastActivityAt: 'desc' },
  });
  const heads = pages
    .map((p) => ({ ...p, headRevisionId: p.branches.find((b) => b.name === p.defaultBranch)?.headRevisionId ?? null }))
    .filter((p): p is typeof p & { headRevisionId: string } => p.headRevisionId !== null);
  if (heads.length === 0) return { summary: t('agent.quality.noPages'), findings: [] };

  const named = new Set(((run.input ?? {}) as AgentRunInput).documentIds ?? []);
  const candidates = named.size > 0 ? heads.filter((p) => named.has(p.id)) : heads;
  const [priors, settings] = await Promise.all([
    latestScores(svc, candidates.map((p) => p.id)),
    svc.prisma.aiSettings.findUnique({ where: { workspaceId: run.workspaceId }, select: { qualityAuditDays: true } }),
  ]);
  const auditDays: number = settings?.qualityAuditDays ?? svc.config.get('QUALITY_AUDIT_DAYS', { infer: true });

  const styleguides = new Map<string, StyleRule[]>();
  const rulesFor = async (projectId: string): Promise<StyleRule[]> => {
    let rules = styleguides.get(projectId);
    if (!rules) {
      rules = (await svc.skills.effectiveStyleguide(run.workspaceId, projectId))?.rules ?? [];
      styleguides.set(projectId, rules);
      if (rules.length > 0) svc.trust(run, JSON.stringify(rules));
    }
    return rules;
  };

  const now = new Date();
  const modelOn = agent.config.enabled && agent.missing.length === 0;
  const due: Array<(typeof heads)[number] & { rules: StyleRule[]; hash: string | null }> = [];
  for (const page of candidates) {
    const rules = await rulesFor(page.projectId);
    const hash = styleguideHash(rules);
    if (isDue(priors.get(page.id) ?? null, page.headRevisionId, hash, auditDays, now, modelOn)) due.push({ ...page, rules, hash });
    if (due.length >= svc.config.get('QUALITY_AUDIT_MAX_PAGES', { infer: true })) break;
  }
  if (due.length === 0) return { summary: t('agent.quality.upToDate'), findings: [] };

  // The facts. Links resolve against every page of the workspace, not only
  // the visible ones: a link to a restricted page is not broken, and the
  // issue names only what this page itself says. An archived page is gone —
  // archiving is how a page is deleted — so a link to it is broken.
  await report({ stage: 'facts', progress: 0.1 });
  const roster = await svc.prisma.document.findMany({
    where: { workspaceId: run.workspaceId },
    select: { id: true, title: true, projectId: true, archivedAt: true, pendingMergeRequestId: true },
  });
  const documentIds = new Set(roster.filter((d) => !d.archivedAt).map((d) => d.id));
  // Titles resolve the way the reader's resolver does: over the listed,
  // unarchived roster, preferring the page's own project.
  const titled = roster.filter((d) => !d.archivedAt && !d.pendingMergeRequestId).map((d) => ({ documentId: d.id, title: d.title, projectId: d.projectId }));
  const resolvers = new Map<string, PageRefResolver>();
  const resolverFor = (projectId: string): PageRefResolver => {
    let resolve = resolvers.get(projectId);
    if (!resolve) {
      resolve = buildPageRefResolver(titled, projectId);
      resolvers.set(projectId, resolve);
    }
    return resolve;
  };

  let peers = new Map<string, QualityDuplicate[]>();
  let pairs: Array<{ a: string; b: string; similarity: number }> = [];
  const embedded = new Set<string>();
  const compared = heads.slice(0, MAX_COMPARED);
  const comparedIds = new Set(compared.map((p) => p.id));
  for (const page of due) if (!comparedIds.has(page.id)) compared.push(page);
  if (svc.config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'stub') {
    // The stub hashes words, so its similarity is shared vocabulary, not
    // shared meaning: every page of one product would pair with every other.
    // Not measured, and said — the surveyor's rule.
    await report({ warning: t('agent.quality.stubEmbeddings') });
  } else try {
    const byRevision = await svc.graph.meanRevisionEmbeddings(run.workspaceId, compared.map((p) => p.headRevisionId));
    const means = new Map<string, number[]>();
    for (const page of compared) {
      const mean = byRevision.get(page.headRevisionId);
      if (mean) means.set(page.id, mean);
    }
    for (const id of means.keys()) embedded.add(id);
    ({ peers, pairs } = duplicatePeers(means, due.map((p) => p.id), svc.config.get('QUALITY_DUPLICATE_THRESHOLD', { infer: true })));
  } catch (error) {
    // No vector store, no duplicate check: the dimension is not measured,
    // which is not the same as measured unique — so it is null, and said.
    svc.logger.warn(`Auditor could not read embeddings: ${String(error)}`);
    await report({ warning: t('agent.quality.noEmbeddings') });
  }
  const titleOf = new Map(heads.map((p) => [p.id, p.title]));

  // The judgement, page by page.
  let modelStopped = !modelOn;
  if (!modelOn) await report({ warning: t('agent.quality.modelOff') });
  let called = 0;
  let reused = 0;
  const rows: Prisma.DocumentQualityScoreCreateManyInput[] = [];
  const scored: Array<{ page: (typeof due)[number]; overall: number; issues: QualityIssue[] }> = [];

  for (const [at, page] of due.entries()) {
    await report({ stage: 'scoring', progress: 0.15 + (0.8 * at) / due.length });
    const content = await svc.documents.getContent(page.id, page.headRevisionId).catch(() => null);
    if (!content) continue;

    let model: ModelHalf | null = reusableModelHalf(priors.get(page.id) ?? null, page.headRevisionId, page.hash);
    if (model) reused += 1;
    else if (!content.markdown.trim()) {
      // Nothing to judge, which is itself the judgement — and a fixed one, so
      // an empty page is not re-asked of the model on every run.
      model = { clarity: 0, completeness: 0, style: null, issues: [{ dimension: 'completeness', severity: 'warning', message: t('agent.quality.empty') }], violations: [] };
    } else if (!modelStopped) {
      try {
        const raw = await svc.client.chat(
          { config: agent.config, userId: principal.userId, operation: 'audit', locale: run.locale as Locale },
          auditMessages(agent.instructions, page.rules, page.title, content.markdown),
          { json: true },
        );
        called += 1;
        model = readModelHalf(parseModelJson(raw), page.rules, content.markdown);
      } catch (error) {
        // Every later page would fail the same way: score the facts only.
        if (await svc.stopsPass(error, report)) modelStopped = true;
        else {
          svc.logger.warn(`Auditor could not score "${page.title}": ${String(error)}`);
          await report({ warning: t('agent.warning.pageNotReviewed', { title: page.title, error: reasonOf(error) }) });
        }
      }
    }

    const links = linkCheck(content.markdown, { documentIds, resolve: resolverFor(page.projectId) });
    const ownership = ownershipCheck(page.ownerId);
    const duplication = duplicationCheck(embedded.has(page.id), peers.get(page.id) ?? [], (id) => titleOf.get(id) ?? id);
    const dimensions: QualityDimensionScores = {
      ...emptyDimensions(),
      clarity: model?.clarity ?? null,
      completeness: model?.completeness ?? null,
      style: model?.style ?? null,
      links: links.score,
      ownership: ownership.score,
      duplication: duplication.score,
    };
    const issues = [...(model?.issues ?? []), ...links.issues, ...ownership.issues, ...duplication.issues];
    const overall = overallScore(dimensions);
    rows.push({
      workspaceId: run.workspaceId,
      projectId: page.projectId,
      documentId: page.id,
      revisionId: page.headRevisionId,
      agentRunId: run.id,
      rubricVersion: RUBRIC_VERSION,
      styleguideHash: page.hash,
      overall,
      dimensions: dimensions as unknown as Prisma.InputJsonValue,
      issues: issues as unknown as Prisma.InputJsonValue,
      duplicates: (peers.get(page.id) ?? []) as unknown as Prisma.InputJsonValue,
    });
    scored.push({ page, overall, issues });
  }

  await report({ stage: 'writing', progress: 0.97 });
  if (rows.length > 0) await svc.prisma.documentQualityScore.createMany({ data: rows });

  const findings: AgentFinding[] = [];
  for (const pair of pairs) {
    if (findings.length >= MAX_FINDINGS) break;
    const [a, b] = [titleOf.get(pair.a) ?? pair.a, titleOf.get(pair.b) ?? pair.b];
    findings.push({
      kind: 'duplicate',
      severity: 'warning',
      title: t('agent.quality.duplicateTitle', { a, b }),
      detail: t('agent.quality.duplicateDetail', { similarity: Math.round(pair.similarity * 100) }),
      documentIds: [pair.a, pair.b],
      documentTitles: [a, b],
    });
  }
  const threshold = svc.config.get('QUALITY_FINDING_THRESHOLD', { infer: true });
  for (const { page, overall, issues } of [...scored].sort((x, y) => x.overall - y.overall)) {
    if (findings.length >= MAX_FINDINGS) break;
    const broken = issues.filter((i) => i.dimension === 'links');
    if (overall >= threshold && broken.length === 0) continue;
    const shown = (overall < threshold ? issues.filter((i) => i.dimension !== 'duplication') : broken).slice(0, 5);
    findings.push({
      kind: 'quality',
      severity: overall < threshold ? 'warning' : 'info',
      title: t(overall < threshold ? 'agent.quality.lowTitle' : 'agent.quality.linksTitle', { title: page.title, score: overall }),
      detail: shown.map((i) => `- ${i.message}`).join('\n').slice(0, 2_000) || t('agent.quality.lowDetail'),
      documentIds: [page.id],
      documentTitles: [page.title],
    });
  }

  const average = scored.length ? Math.round(scored.reduce((sum, s) => sum + s.overall, 0) / scored.length) : 0;
  return {
    summary: t('agent.quality.summary', {
      pages: t('agent.count.pages', { count: scored.length }),
      average,
      calls: called,
      reused,
    }),
    findings,
  };
}

/** Each page's newest score, one `DISTINCT ON` over the bounded id set. */
async function latestScores(svc: AgentServices, documentIds: string[]): Promise<Map<string, PriorScore>> {
  if (documentIds.length === 0) return new Map();
  const rows = await svc.prisma.$queryRaw<Array<PriorScore & { documentId: string }>>(Prisma.sql`
    SELECT DISTINCT ON (document_id)
      document_id AS "documentId", revision_id AS "revisionId", rubric_version AS "rubricVersion",
      styleguide_hash AS "styleguideHash", created_at AS "createdAt", dimensions, issues
    FROM document_quality_scores
    WHERE document_id IN (${Prisma.join(documentIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY document_id, created_at DESC`);
  return new Map(rows.map((r) => [r.documentId, r]));
}
