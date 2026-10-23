import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  testSuiteCurl,
  testSuitePostman,
  type AgentRunInput,
  type ApiTestSuiteFormat,
  type ApiTestSuiteResponse,
  type GenerateApiTestSuiteResponse,
} from '@knowledge/contracts';
import { AgentProducer } from '../agents/agent.producer.js';
import { AgentRegistryService, type ResolvedAgent } from '../agents/agent-registry.service.js';
import { testerConfigHash } from '../agents/tester.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import type { Principal } from '../auth/principal.js';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiTestSuitesService, type SuiteOperation } from './api-test-suites.service.js';

const TESTER = 'tester';

/**
 * The request half of QA test suites (#468): read, export, and Generate.
 * Generate answers from the cache when it can — an unchanged operation costs
 * no model call — and otherwise queues a `tester` run, one per cache key in
 * flight. The capability was checked by the route's guard; the run checks it
 * again when it executes.
 */
@Injectable()
export class ApiTestSuiteRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly suites: ApiTestSuitesService,
    private readonly registry: AgentRegistryService,
    private readonly producer: AgentProducer,
    private readonly usage: AiUsageService,
  ) {}

  async get(documentId: string, entityKey: string): Promise<ApiTestSuiteResponse> {
    return (await this.cached(documentId, entityKey)).suite;
  }

  /** The cached suite as a file: one curl command per case, or a Postman Collection v2.1. */
  async export(
    documentId: string,
    entityKey: string,
    format: ApiTestSuiteFormat,
  ): Promise<{ body: string; filename: string; contentType: string }> {
    const { suite, at } = await this.cached(documentId, entityKey);
    const { spec, op } = at;
    const name = `${spec.slug ?? 'api'}-${op.method ?? ''}-${op.path}`.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '');
    if (format === 'curl') {
      return { body: testSuiteCurl(suite.cases), filename: `${name}.sh`, contentType: 'text/x-shellscript; charset=utf-8' };
    }
    const collection = testSuitePostman({ title: `${spec.title} — ${op.method} ${op.path}`, folder: `${op.method} ${op.path}`, cases: suite.cases });
    return {
      body: JSON.stringify(collection, null, 2),
      filename: `${name}.postman_collection.json`,
      contentType: 'application/json; charset=utf-8',
    };
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

    // Two clicks racing on one key must start one run: the lookup and the
    // insert run under one advisory lock per key (the AgentTriggerService way).
    const subjectKey = this.suites.subjectKey(at, agentHash);
    const input: AgentRunInput = { apiTestSuite: { documentId, entityKey: at.op.entityKey, revisionId: at.spec.revisionId } };
    const started = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${subjectKey}))`;
      const waiting = await tx.agentRun.findFirst({
        where: { workspaceId, agentKey: TESTER, subjectKey, status: { in: ['pending', 'running'] } },
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
    return { suite: null, ...started };
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
