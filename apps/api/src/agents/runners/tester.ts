import type { AgentRun } from '@prisma/client';
import { type AgentRunInput, type ApiTestCaseFill, type Locale, buildTestSuite, operationFingerprint, testCasesFor } from '@knowledge/contracts';
import { t } from '../../i18n/t.js';
import type { ResolvedAgent } from '../agent-registry.service.js';
import type { Principal } from '../../auth/principal.js';
import { TESTER_OUTPUT_CONTRACT, TESTER_RANKING_CONTRACT, boundCaptures, readTesterRanking, testerConfigHash, testerPrompt, testerRankingPrompt } from '../tester.js';
import { parseModelJson } from '../../common/model-json.js';
import type { AgentServices, AgentRunner, AgentReporter, AgentRunResult } from '../agent-services.js';

export const testerRunner: AgentRunner = {
  key: 'tester',
  // Only Generate (#468) or Ask tester (#483) on an operation card names an operation.
  run: (svc, run, agent, principal, report) =>
    ((run.input ?? {}) as AgentRunInput).apiFixtureRanking
      ? rankFixtures(svc, run, agent, principal, report)
      : writeTestSuite(svc, run, agent, principal, report),
};

/**
 * The tester (#468): one API operation's QA suite. The case list is the
 * catalogue's; the model only fills values and words, and `buildTestSuite`
 * completes every case it left out — or throws when one cannot be built
 * honestly, so a suite is never stored partial.
 *
 * The capability is checked here as well as at the route: revoking it
 * between the click and this run fails the run before any model call.
 */
async function writeTestSuite(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = ((run.input ?? {}) as AgentRunInput).apiTestSuite;
  if (!input) throw new Error(t('agent.testerRun.noOperation'));
  await svc.access.requireRole(principal, run.workspaceId, 'viewer', false, { capability: 'api-test-suites.generate' });
  const scope = await svc.permissions.scopeFor(principal, run.workspaceId);
  await svc.permissions.requireLevel(scope, { type: 'document', id: input.documentId }, 'view');

  const at = await svc.testSuites.operationAt(input.documentId, input.entityKey, input.revisionId);
  if (at.op.workspaceId !== run.workspaceId) throw new Error(t('agent.testerRun.noOperation'));
  const cases = testCasesFor(at.spec.document, at.op);
  if (!agent.config.enabled || agent.missing.length > 0) throw new Error(t('error.apiTestSuite.noModel'));
  // Bound fixtures (#483) as the run's owner sees them: one they cannot open fails the run.
  const { captures, vars } = boundCaptures(await svc.fixtures.bound(scope, at.bindings));

  await report({ stage: 'thinking', progress: 0.3 });
  const call = { config: agent.config, userId: run.createdBy, operation: 'test-suite' as const, locale: run.locale as Locale };
  const raw = await svc.client.chat(
    call,
    [
      { role: 'system', content: `${agent.instructions}\n\n${TESTER_OUTPUT_CONTRACT}${await svc.guidance(run, agent)}` },
      {
        role: 'user',
        content: testerPrompt({ method: at.op.method ?? '', path: at.op.path }, cases, operationFingerprint(at.spec.document, at.op), captures),
      },
    ],
    { json: true },
  );
  const parsed = parseModelJson(raw) ?? {};
  const fills = (parsed.cases && typeof parsed.cases === 'object' ? parsed.cases : {}) as Record<string, ApiTestCaseFill>;
  const suite = buildTestSuite(at.spec.document, at.op, parsed.baseline, fills, vars);

  await svc.testSuites.save(at, testerConfigHash(agent), suite, { userId: run.createdBy, agentRunId: run.id });
  return {
    summary: t('agent.testerRun.summary', { count: suite.length, method: at.op.method ?? '', path: at.op.path }),
    findings: [],
  };
}

/**
 * Ask tester (#483): order one operation's fixture candidates and say why.
 * The candidates are recomputed here under the run owner's scope, and the
 * order is stored with the hash of the set it ranked, so the candidates
 * route applies it only while that set is unchanged. Binds nothing.
 */
async function rankFixtures(
  svc: AgentServices,
  run: AgentRun,
  agent: ResolvedAgent,
  principal: Principal,
  report: AgentReporter,
): Promise<AgentRunResult> {
  const input = ((run.input ?? {}) as AgentRunInput).apiFixtureRanking!;
  await svc.access.requireRole(principal, run.workspaceId, 'viewer', false, { capability: 'api-test-suites.generate' });
  const scope = await svc.permissions.scopeFor(principal, run.workspaceId);
  await svc.permissions.requireLevel(scope, { type: 'document', id: input.documentId }, 'view');
  const at = await svc.testSuites.operationAt(input.documentId, input.entityKey);
  if (at.op.workspaceId !== run.workspaceId) throw new Error(t('agent.testerRun.noOperation'));
  const { prerequisites, candidates, hash } = await svc.fixtures.candidates(scope, at);
  if (!candidates.length) throw new Error(t('agent.testerRun.noCandidates'));
  if (!agent.config.enabled || agent.missing.length > 0) throw new Error(t('error.apiTestSuite.noModel'));
  const bodies = await Promise.all(
    candidates.map(async (candidate) => ({
      candidate,
      fixture: await svc.fixtures.get(scope, candidate.documentId).then((f) => f.fixture, () => null),
    })),
  );

  await report({ stage: 'thinking', progress: 0.3 });
  const op = { method: at.op.method ?? '', path: at.op.path };
  const raw = await svc.client.chat(
    { config: agent.config, userId: run.createdBy, operation: 'test-fixture-ranking' as const, locale: run.locale as Locale },
    [
      { role: 'system', content: `${agent.instructions}\n\n${TESTER_RANKING_CONTRACT}${await svc.guidance(run, agent)}` },
      { role: 'user', content: testerRankingPrompt(op, prerequisites, bodies) },
    ],
    { json: true },
  );
  const order = readTesterRanking(parseModelJson(raw), candidates.map((c) => c.documentId));
  return {
    summary: t('agent.testerRun.rankSummary', { count: order.length, ...op }),
    findings: [],
    details: { fixtureRanking: { candidatesHash: hash, order } },
  };
}
