import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  testSuiteCurl,
  testSuitePostman,
  type AgentRunDetails,
  type AgentRunInput,
  type ApiTestBindingInfo,
  type ApiTestBindingsResponse,
  type ApiTestFixtureCandidatesResponse,
  type ApiTestRankingStatus,
  type ApiTestSuiteFormat,
  type ApiTestSuiteResponse,
  type GenerateApiTestSuiteResponse,
  type RankApiTestFixturesResponse,
  type TestRunPlan,
} from '@knowledge/contracts';
import { AgentProducer } from '../agents/agent.producer.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { testerConfigHash } from '../agents/tester.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { canSee, type AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiFixturesService } from './api-fixtures.service.js';
import { ApiTestSuitesService, type SuiteBinding, type SuiteOperation } from './api-test-suites.service.js';

const TESTER = 'tester';

/**
 * The request half of QA test suites (#468): read, export, and Generate.
 * Generate answers from the cache when it can — an unchanged operation costs
 * no model call — and otherwise queues a `tester` run, one per cache key in
 * flight. The capability was checked by the route's guard; the run checks it
 * again when it executes.
 *
 * Fixtures (#483): the bindings a person confirms, the candidates offered for
 * them, and the tester's ranking of those — a run like Generate, whose answer
 * stays on the run row and is applied only to the candidate set it ranked.
 */
@Injectable()
export class ApiTestSuiteRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suites: ApiTestSuitesService,
    private readonly fixtures: ApiFixturesService,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
    private readonly usage: AiUsageService,
  ) {}

  async get(documentId: string, entityKey: string): Promise<ApiTestSuiteResponse> {
    return (await this.cached(documentId, entityKey)).suite;
  }

  /**
   * The cached suite as a file, with its bound fixtures' setup and teardown:
   * a bash script (curl + jq), or a Postman Collection v2.1. Refused when the
   * caller cannot open a bound fixture.
   */
  async export(
    scope: AccessScope,
    documentId: string,
    entityKey: string,
    format: ApiTestSuiteFormat,
  ): Promise<{ body: string; filename: string; contentType: string }> {
    const { suite, at } = await this.cached(documentId, entityKey);
    const { spec, op } = at;
    const name = `${spec.slug ?? 'api'}-${op.method ?? ''}-${op.path}`.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
    const chain = await this.fixtures.chain(scope, at, suite.cases, `${spec.title} — ${op.method} ${op.path}`);
    if (format === 'curl') {
      return { body: testSuiteCurl(chain), filename: `${name}.sh`, contentType: 'text/x-shellscript; charset=utf-8' };
    }
    const collection = testSuitePostman(chain, `${op.method} ${op.path}`);
    return {
      body: JSON.stringify(collection, null, 2),
      filename: `${name}.postman_collection.json`,
      contentType: 'application/json; charset=utf-8',
    };
  }

  /**
   * The cached suite as a run plan (#483, phase 3) for the browser runner or
   * an agent's own HTTP client. Placeholders only: a run supplies the values.
   */
  async plan(scope: AccessScope, documentId: string, entityKey: string): Promise<TestRunPlan> {
    const { suite, at } = await this.cached(documentId, entityKey);
    return this.fixtures.plan(scope, at, suite.cases, `${at.spec.title} — ${at.op.method} ${at.op.path}`);
  }

  async generate(principal: Principal, documentId: string, entityKey: string, regenerate: boolean): Promise<GenerateApiTestSuiteResponse> {
    const { at, agent } = await this.resolve(documentId, entityKey);
    const workspaceId = at.op.workspaceId;
    if (!agent.enabled) throw new BadRequestException(t('error.apiTestSuite.disabled'));
    if (!agent.config.enabled || agent.missing.length > 0) throw new BadRequestException(t('error.apiTestSuite.noModel'));
    const agentHash = testerConfigHash(agent);
    if (!regenerate) {
      const row = await this.suites.find(at, agentHash);
      if (row) return { suite: this.suites.toResponse(row), runId: null, existing: false };
    }
    await this.usage.assertWithinBudget(workspaceId, principal.userId);

    const input: AgentRunInput = { apiTestSuite: { documentId, entityKey: at.op.entityKey, revisionId: at.spec.revisionId } };
    const started = await this.startRun(principal, workspaceId, this.suites.subjectKey(at, agentHash), input, ['pending', 'running']);
    return { suite: null, ...started };
  }

  /**
   * Queue a tester run for `subjectKey`, unless one in `reuse` states already
   * exists. Two clicks racing on one key must start one run: the lookup and
   * the insert run under one advisory lock per key (the AgentTriggerService way).
   */
  private async startRun(
    principal: Principal,
    workspaceId: string,
    subjectKey: string,
    input: AgentRunInput,
    reuse: string[],
  ): Promise<{ runId: string; existing: boolean }> {
    const started = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subjectKey}))`;
      const waiting = await tx.agentRun.findFirst({
        where: { workspaceId, agentKey: TESTER, subjectKey, status: { in: reuse } },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });
      if (waiting) return { runId: waiting.id, existing: true };
      const override = await tx.aiAgent.findUnique({
        where: { workspaceId_key: { workspaceId, key: TESTER } },
        select: { id: true },
      });
      const run = await tx.agentRun.create({
        data: {
          workspaceId,
          agentKey: TESTER,
          agentId: override?.id ?? null,
          trigger: 'manual',
          subjectKey,
          createdBy: principal.userId,
          locale: principal.locale,
          input: input as unknown as Prisma.InputJsonValue,
        },
      });
      return { runId: run.id, existing: false };
    });
    if (!started.existing) await this.producer.enqueue(started.runId);
    return started;
  }

  /** The fixtures bound to one operation's suite. A fixture the scope cannot open keeps its row but loses its title. */
  async bindings(scope: AccessScope, documentId: string, entityKey: string): Promise<ApiTestBindingsResponse> {
    const at = await this.suites.operationAt(documentId, entityKey);
    return this.bindingsResponse(scope, at.op.documentId, at.op.entityKey, at.bindings);
  }

  /** Replace one suite's bindings — a person's confirmation; the route checked `api-test-suites.generate`. */
  async setBindings(
    principal: Principal,
    scope: AccessScope,
    documentId: string,
    entityKey: string,
    list: ReadonlyArray<{ caseId: string | null; fixtureId: string }>,
  ): Promise<ApiTestBindingsResponse> {
    const at = await this.suites.operationAt(documentId, entityKey);
    const bindings = await this.suites.setBindings(scope, at, list, principal.userId);
    return this.bindingsResponse(scope, at.op.documentId, at.op.entityKey, bindings);
  }

  /** Fixtures that could set up the suite, in spec order — or the tester's, once it ranked this exact set. */
  async candidates(scope: AccessScope, documentId: string, entityKey: string): Promise<ApiTestFixtureCandidatesResponse> {
    const at = await this.suites.operationAt(documentId, entityKey);
    const { prerequisites, candidates, hash } = await this.fixtures.candidates(scope, at);
    const run = await this.prisma.agentRun.findFirst({
      where: { workspaceId: at.op.workspaceId, agentKey: TESTER, subjectKey: rankingSubject(hash) },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, details: true },
    });
    const status: ApiTestRankingStatus = !run
      ? 'none'
      : run.status === 'succeeded'
        ? 'ready'
        : run.status === 'pending' || run.status === 'running'
          ? 'pending'
          : 'failed';
    const ranking = status === 'ready' ? (run!.details as AgentRunDetails | null)?.fixtureRanking : undefined;
    const ordered =
      ranking?.candidatesHash === hash
        ? ranking.order.flatMap((r) => {
            const c = candidates.find((x) => x.documentId === r.documentId);
            return c ? [{ ...c, explanation: r.explanation }] : [];
          })
        : candidates;
    return {
      documentId: at.op.documentId,
      entityKey: at.op.entityKey,
      prerequisites,
      candidates: ordered,
      ranking: { status, runId: run?.id ?? null },
    };
  }

  /**
   * Ask the tester to rank the current candidate set: one run per set, ever —
   * a set already ranked (or being ranked) returns that run, and costs nothing.
   */
  async rank(principal: Principal, scope: AccessScope, documentId: string, entityKey: string): Promise<RankApiTestFixturesResponse> {
    const { at, agent } = await this.resolve(documentId, entityKey);
    const workspaceId = at.op.workspaceId;
    if (!agent.enabled) throw new BadRequestException(t('error.apiTestSuite.disabled'));
    if (!agent.config.enabled || agent.missing.length > 0) throw new BadRequestException(t('error.apiTestSuite.noModel'));
    const { candidates, hash } = await this.fixtures.candidates(scope, at);
    if (!candidates.length) throw new BadRequestException(t('error.apiTestSuite.rankNothing'));
    await this.usage.assertWithinBudget(workspaceId, principal.userId);
    const input: AgentRunInput = { apiFixtureRanking: { documentId, entityKey: at.op.entityKey, candidatesHash: hash } };
    return this.startRun(principal, workspaceId, rankingSubject(hash), input, ['pending', 'running', 'succeeded']);
  }

  private async bindingsResponse(
    scope: AccessScope,
    documentId: string,
    entityKey: string,
    bindings: SuiteBinding[],
  ): Promise<ApiTestBindingsResponse> {
    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(bindings.map((b) => b.fixtureId))] } },
      select: { id: true, projectId: true, path: true, restrictedBy: true },
    });
    const visible = new Set(docs.filter((d) => canSee(scope, d)).map((d) => d.id));
    const info = (b: SuiteBinding): ApiTestBindingInfo => ({
      fixtureId: b.fixtureId,
      title: visible.has(b.fixtureId) ? b.title : null,
      headRevisionId: visible.has(b.fixtureId) ? b.headRevisionId : null,
      archived: b.archived,
    });
    const cases: Record<string, ApiTestBindingInfo[]> = {};
    for (const b of bindings) if (b.caseId !== null) (cases[b.caseId] ??= []).push(info(b));
    return { documentId, entityKey, suite: bindings.filter((b) => b.caseId === null).map(info), cases };
  }

  /** The suite cached for the operation as it stands at the head, or 404. */
  private async cached(documentId: string, entityKey: string): Promise<{ suite: ApiTestSuiteResponse; at: SuiteOperation }> {
    const { at, agent } = await this.resolve(documentId, entityKey);
    const row = await this.suites.find(at, testerConfigHash(agent));
    if (!row) throw new NotFoundException(t('error.apiTestSuite.notGenerated'));
    return { suite: this.suites.toResponse(row), at };
  }

  private async resolve(documentId: string, entityKey: string): Promise<{ at: SuiteOperation; agent: ResolvedAgent }> {
    const at = await this.suites.operationAt(documentId, entityKey);
    return { at, agent: await this.registry.resolve(at.op.workspaceId, TESTER) };
  }
}

/** One ranking run per candidate set: the set's hash is the run's subject. */
export const rankingSubject = (hash: string) => `api-fixture-ranking:${hash.slice(0, 40)}`;
