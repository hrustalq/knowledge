import type { AgentRun } from '@prisma/client';
import type { AgentFinding, AgentRunInput, AnswerSignalKind, AnswerSurface, Locale } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { visibilityWhere } from '../../permissions/access-scope.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { COVERAGE_OUTPUT_CONTRACT, EMBED_BATCH, MAX_CLUSTERS, citedIdsOf, clusterSignals, coverageOf, coveragePrompt, normalizeQuestion, questionKey, readCoverageVerdict, type CoverageSignal } from '../coverage.js';
import { parseModelJson } from '../../common/model-json.js';
import { type AgentServices, type AgentRunner, type AgentReporter, type AgentRunResult, UUID, MAX_FINDINGS, reasonOf, runBrief } from '../agent-services.js';

export const surveyorRunner: AgentRunner = { key: 'surveyor', run: surveyCoverage };

/**
 * Clusters the questions answers failed on into coverage gaps
 * (docs/features/38, phase 4).
 *
 * Three stages, two of them no model. `signals` reads `answer_feedback` for
 * the window: down-votes, low-confidence turns, turns with no answer — the
 * misses only, since a good answer nobody rated wrote nothing. `clustering`
 * embeds each distinct question with the workspace's embedding provider and
 * joins them greedily by cosine to a centroid; clusters under the minimum
 * size are dropped. Only `topics` is judgement: one tool loop per cluster,
 * with the questions wrapped as the untrusted text they are, returning the
 * topic's name, what the workspace already says, and one of three fixes.
 *
 * Every finding carries `coverage` — the questions, the count, the signal
 * mix — so it is grounded whether or not the model cited a page: the cluster
 * is a fact about feedback, and the proposal is what the model adds. A
 * person then creates the drafted page, proposes the edit, or starts the
 * archaeologist; the run never writes.
 */
async function surveyCoverage(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = (run.input ?? {}) as AgentRunInput;
  const windowDays =
    input.coverage?.windowDays && input.coverage.windowDays > 0
      ? Math.trunc(input.coverage.windowDays)
      : svc.config.get('COVERAGE_WINDOW_DAYS', { infer: true });
  const minSize = svc.config.get('COVERAGE_MIN_CLUSTER_SIZE', { infer: true });
  const threshold = svc.config.get('COVERAGE_SIMILARITY', { infer: true });
  const maxQuestions = svc.config.get('COVERAGE_MAX_QUESTIONS', { infer: true });

  // The stub provider hashes words: two phrasings of one question land far
  // apart and two unrelated questions sharing a word land close. Clusters
  // over it would be junk with a confident count on them, so the run says so
  // and stops — the one honest answer a fixture can give.
  if (svc.config.get('EMBEDDINGS_PROVIDER', { infer: true }) === 'stub') {
    return { summary: t('agent.coverage.noEmbedding'), findings: [] };
  }

  // --- what failed, in the window
  await report({ stage: 'signals', progress: 0.05 });
  const scope = await svc.runScope(run, principal);
  const since = new Date(Date.now() - windowDays * 86_400_000);
  const rows = await svc.prisma.answerFeedback.findMany({
    where: {
      workspaceId: run.workspaceId,
      createdAt: { gte: since },
      OR: [{ kind: { in: ['low-confidence', 'no-answer'] } }, { kind: 'vote', rating: 'down' }],
    },
    select: { id: true, query: true, kind: true, surface: true },
    orderBy: { createdAt: 'desc' },
    take: maxQuestions,
  });
  const signals: CoverageSignal[] = rows
    .filter((r) => questionKey(r.query).length >= 3)
    .map((r) => ({ id: r.id, query: r.query, kind: r.kind as AnswerSignalKind, surface: r.surface as AnswerSurface }));
  if (signals.length === 0) return { summary: t('agent.coverage.noSignals', { days: windowDays }), findings: [] };

  // --- which of them are one topic: one embedding per distinct text
  await report({ stage: 'clustering', progress: 0.15 });
  const texts = new Map<string, string>();
  for (const s of signals) texts.set(questionKey(s.query), normalizeQuestion(s.query));
  const keys = [...texts.keys()];
  const vectors = new Map<string, number[]>();
  for (let at = 0; at < keys.length; at += EMBED_BATCH) {
    const slice = keys.slice(at, at + EMBED_BATCH);
    const embedded = await svc.embedding.embedBatch(slice.map((k) => texts.get(k)!));
    slice.forEach((k, i) => vectors.set(k, embedded[i]));
    await report({ stage: 'clustering', progress: 0.15 + (0.25 * Math.min(at + EMBED_BATCH, keys.length)) / keys.length });
  }
  const clusters = clusterSignals(signals, vectors, { threshold, minSize, maxClusters: MAX_CLUSTERS });
  const counts = { signals: signals.length, questions: keys.length, clusters: clusters.length };
  if (clusters.length === 0) return { summary: t('agent.coverage.tooFew', { ...counts, min: minSize }), findings: [] };

  // --- the judgement: one tool loop per cluster
  const hasCodebase =
    (await svc.prisma.connector.count({ where: { workspaceId: run.workspaceId, enabled: true, kind: 'codebase' } })) > 0;
  const blocking = agent.missing.filter((capability) => capability !== 'tools');
  if (!agent.config.enabled || blocking.length > 0) {
    // No model: the clusters are still the facts a reader came for, so each
    // becomes a finding with no proposal — named by its most-asked question.
    await report({ warning: t('agent.coverage.noModel') });
    return {
      summary: t('agent.coverage.summaryNoModel', counts),
      findings: clusters.map((cluster) => ({
        kind: 'gap' as const,
        severity: 'info' as const,
        title: cluster.questions[0],
        detail: t('agent.coverage.noModelDetail', { count: cluster.count }),
        documentIds: [],
        documentTitles: [],
        coverage: coverageOf(cluster, 'create-page'),
      })),
    };
  }

  const skills = await svc.guidance(run, agent);
  const call = { config: agent.config, userId: run.createdBy, operation: 'agent' as const, locale: run.locale as Locale };
  const execute = svc.readTool(run, principal);
  const findings: AgentFinding[] = [];
  let judged = 0;

  for (const [at, cluster] of clusters.entries()) {
    await report({ stage: 'topics', progress: 0.4 + (0.55 * at) / clusters.length });
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: `${agent.instructions}\n\n${COVERAGE_OUTPUT_CONTRACT}${skills}` },
      {
        role: 'user',
        content:
          runBrief(input) +
          coveragePrompt(cluster, { hasCodebase, windowDays }),
      },
    ];
    const fallbackDetail = t('agent.coverage.noModelDetail', { count: cluster.count });
    try {
      const raw = await svc.callModel(call, agent, messages, execute);
      judged += 1;
      const parsed = parseModelJson(raw);
      // A cited page must exist here: one query over whatever the model
      // named, and `readCoverageVerdict` keeps only what came back.
      const cited = citedIdsOf(parsed).filter((id) => UUID.test(id));
      const known = new Map(
        cited.length
          ? (
              await svc.prisma.document.findMany({
                where: { id: { in: cited }, workspaceId: run.workspaceId, AND: [visibilityWhere(scope)] },
                select: { id: true, title: true },
              })
            ).map((d) => [d.id, d.title])
          : [],
      );
      findings.push(readCoverageVerdict(parsed, cluster, known, { hasCodebase, fallbackDetail }));
    } catch (error) {
      if (await svc.stopsPass(error, report, () => t('agent.coverage.budgetSpent', { judged, clusters: clusters.length }))) break;
      // Not judged is not "no gap": the cluster still lands, unnamed.
      svc.logger.warn(`Surveyor could not judge a cluster: ${String(error)}`);
      await report({ warning: t('agent.warning.modelPassFailed', { error: reasonOf(error) }) });
      findings.push(readCoverageVerdict(null, cluster, new Map(), { hasCodebase, fallbackDetail }));
    }
    if (findings.length >= MAX_FINDINGS) break;
  }

  return {
    summary: t('agent.coverage.summary', { ...counts, judged, findings: findings.length }),
    findings: findings.slice(0, MAX_FINDINGS),
  };
}
