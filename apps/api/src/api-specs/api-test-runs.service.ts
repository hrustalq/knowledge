import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type ApiTestEnvironment, type ApiTestRun } from '@prisma/client';
import {
  API_TEST_RUNS_KEPT,
  normalizeEntityKey,
  type ApiTestRunDetail,
  type ApiTestRunStatus,
  type ApiTestRunSummary,
  type QaOperationRow,
  type TestRunPlan,
  type TestRunResult,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiSettingsService } from './api-settings.service.js';
import { ApiTestRunProducer } from './api-test-run.producer.js';

type RunRow = ApiTestRun & { environment: Pick<ApiTestEnvironment, 'id' | 'name'> | null };

/**
 * QA server run records (#483, phase 5). The API inserts a run `queued` with
 * the plan the person's scope resolved — placeholders, never a value — and
 * queues its id; the worker claims it, runs it, writes the results and keeps
 * the last API_TEST_RUNS_KEPT per suite. Readable by viewers of the spec.
 */
@Injectable()
export class ApiTestRunsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ApiSettingsService,
    private readonly producer: ApiTestRunProducer,
  ) {}

  /** 403 unless the runner applies here: the deployment's ceiling and the workspace's switch both on. */
  async assertOn(workspaceId: string): Promise<void> {
    if ((await this.settings.testRunner(workspaceId)).effective !== 'on') {
      throw new ForbiddenException({ statusCode: 403, message: t('error.apiTestRun.off'), reason: 'runner-off' });
    }
  }

  async start(input: { workspaceId: string; plan: TestRunPlan; environmentId: string; createdBy: string }): Promise<ApiTestRunSummary> {
    await this.assertOn(input.workspaceId);
    const env = await this.prisma.apiTestEnvironment.findFirst({ where: { id: input.environmentId, workspaceId: input.workspaceId } });
    if (!env) throw new NotFoundException(t('error.apiTestEnvironment.notFound', { id: input.environmentId }));
    const row = await this.prisma.apiTestRun.create({
      data: {
        workspaceId: input.workspaceId,
        documentId: input.plan.documentId,
        entityKey: input.plan.entityKey,
        environmentId: env.id,
        plan: input.plan as unknown as Prisma.InputJsonValue,
        createdBy: input.createdBy,
      },
      include: { environment: { select: { id: true, name: true } } },
    });
    try {
      await this.producer.enqueue(row.id);
    } catch (e) {
      // A run nobody will pick up must not sit `queued` forever.
      await this.finish(row.id, { status: 'error', error: (e as Error).message });
      throw e;
    }
    return toSummary(row);
  }

  /** The suite's runs, newest first. */
  async list(documentId: string, entityKey: string): Promise<ApiTestRunSummary[]> {
    const rows = await this.prisma.apiTestRun.findMany({
      where: { documentId, entityKey: normalizeEntityKey(entityKey) },
      orderBy: { createdAt: 'desc' },
      take: API_TEST_RUNS_KEPT,
      include: { environment: { select: { id: true, name: true } } },
    });
    return rows.map(toSummary);
  }

  async get(documentId: string, runId: string): Promise<ApiTestRunDetail> {
    const row = await this.prisma.apiTestRun.findUnique({ where: { id: runId }, include: { environment: { select: { id: true, name: true } } } });
    // Another spec's run 404s here: the route's guard checked this document, not that one.
    if (!row || row.documentId !== documentId) throw new NotFoundException(t('error.apiTestRun.notFound', { id: runId }));
    return {
      ...toSummary(row),
      plan: row.plan as unknown as TestRunPlan,
      results: row.results as unknown as Record<string, TestRunResult>,
    };
  }

  /** The newest run per suite of these specs, keyed `documentId\0entityKey` (the QA overview). */
  async latest(documentIds: string[]): Promise<Map<string, NonNullable<QaOperationRow['lastRun']>>> {
    if (!documentIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<Array<Pick<ApiTestRun, 'id' | 'status' | 'passed' | 'failed'> & { document_id: string; entity_key: string; not_run: number; finished_at: Date | null }>>`
      SELECT DISTINCT ON (document_id, entity_key) id, document_id, entity_key, status, passed, failed, not_run, finished_at
        FROM api_test_runs WHERE document_id = ANY(${documentIds}::uuid[])
       ORDER BY document_id, entity_key, created_at DESC`;
    return new Map(
      rows.map((r) => [
        `${r.document_id}\u0000${r.entity_key}`,
        {
          id: r.id,
          status: r.status as ApiTestRunStatus,
          counts: { passed: r.passed, failed: r.failed, notRun: r.not_run },
          finishedAt: r.finished_at?.toISOString() ?? null,
        },
      ]),
    );
  }

  /** The worker's claim: one transition out of `queued`, so a duplicate job runs nothing. */
  async claim(runId: string): Promise<ApiTestRun | null> {
    const { count } = await this.prisma.apiTestRun.updateMany({ where: { id: runId, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
    return count ? this.prisma.apiTestRun.findUnique({ where: { id: runId } }) : null;
  }

  /** Write the outcome, then drop all but the suite's newest API_TEST_RUNS_KEPT runs. */
  async finish(
    runId: string,
    out: { status: ApiTestRunStatus; error?: string | null; results?: Record<string, TestRunResult>; counts?: { passed: number; failed: number; notRun: number } },
  ): Promise<void> {
    const row = await this.prisma.apiTestRun.update({
      where: { id: runId },
      data: {
        status: out.status,
        error: out.error ?? null,
        ...(out.results ? { results: out.results as unknown as Prisma.InputJsonValue } : {}),
        ...(out.counts ? { passed: out.counts.passed, failed: out.counts.failed, notRun: out.counts.notRun } : {}),
        finishedAt: new Date(),
      },
    });
    await this.prisma.$executeRaw`
      DELETE FROM api_test_runs
       WHERE document_id = ${row.documentId}::uuid AND entity_key = ${row.entityKey}
         AND id NOT IN (SELECT id FROM api_test_runs WHERE document_id = ${row.documentId}::uuid AND entity_key = ${row.entityKey}
                         ORDER BY created_at DESC LIMIT ${API_TEST_RUNS_KEPT})`;
  }
}

function toSummary(row: RunRow): ApiTestRunSummary {
  return {
    id: row.id,
    documentId: row.documentId,
    entityKey: row.entityKey,
    environment: row.environment ? { id: row.environment.id, name: row.environment.name } : null,
    status: row.status as ApiTestRunStatus,
    counts: { passed: row.passed, failed: row.failed, notRun: row.notRun },
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}
