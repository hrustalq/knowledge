import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiOperation, ApiTestSuite, Prisma } from '@prisma/client';
import {
  TEST_CASE_CATALOGUE_VERSION,
  normalizeEntityKey,
  operationFingerprint,
  type ApiSpecDocumentResponse,
  type ApiTestCase,
  type ApiTestSuiteResponse,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';

/** One HTTP operation at one spec revision, with the operation half of its suite's cache key. */
export interface SuiteOperation {
  spec: ApiSpecDocumentResponse;
  op: ApiOperation;
  /** SHA-256 of `operationFingerprint`: unchanged by spec edits that do not reach this operation. */
  operationHash: string;
}

/**
 * The store of QA test suites (#468): which operation a suite is for, the key
 * it is cached under, and the row. Controller-free so both processes load it —
 * the API reads and serves suites, the worker's `tester` run writes them. The
 * agent half of the key (`testerConfigHash`) is the caller's to compute and
 * pass in: the registry lives in a module that imports this one.
 */
@Injectable()
export class ApiTestSuitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reads: ApiSpecReadService,
  ) {}

  /** The operation at `revisionId`, or at the default-branch head. 400 for an AsyncAPI spec, 404 for no such operation. */
  async operationAt(documentId: string, entityKey: string, revisionId?: string): Promise<SuiteOperation> {
    const spec = await this.reads.spec(documentId, revisionId);
    if (spec.kind !== 'openapi') throw new BadRequestException(t('error.apiTestSuite.notHttp'));
    const key = normalizeEntityKey(entityKey);
    const op = await this.prisma.apiOperation.findFirst({
      where: { revisionId: spec.revisionId, entityKey: key, protocol: 'http' },
      orderBy: { createdAt: 'asc' },
    });
    if (!op) throw new NotFoundException(t('error.apiTry.operationNotInSpec', { method: '', entityKey: key }));
    const operationHash = createHash('sha256').update(operationFingerprint(spec.document, op)).digest('hex');
    return { spec, op, operationHash };
  }

  find(at: SuiteOperation, agentHash: string): Promise<ApiTestSuite | null> {
    return this.prisma.apiTestSuite.findUnique({ where: { documentId_entityKey_operationHash_catalogueVersion_agentHash: this.key(at, agentHash) } });
  }

  /** Store a suite under its key, replacing whatever that key held — which is what Regenerate is. */
  save(at: SuiteOperation, agentHash: string, cases: ApiTestCase[], by: { userId: string; agentRunId: string }): Promise<ApiTestSuite> {
    const data = {
      cases: cases as unknown as Prisma.InputJsonValue,
      revisionId: at.spec.revisionId,
      agentRunId: by.agentRunId,
      generatedBy: by.userId,
      generatedAt: new Date(),
    };
    const key = this.key(at, agentHash);
    return this.prisma.apiTestSuite.upsert({
      where: { documentId_entityKey_operationHash_catalogueVersion_agentHash: key },
      create: { ...key, workspaceId: at.op.workspaceId, ...data },
      update: data,
    });
  }

  /** The cache key as one short string, for an agent run's `subjectKey`: one run per key in flight. */
  subjectKey(at: SuiteOperation, agentHash: string): string {
    const digest = createHash('sha256').update(JSON.stringify(Object.values(this.key(at, agentHash)))).digest('hex');
    return `api-test-suite:${digest.slice(0, 40)}`;
  }

  toResponse(row: ApiTestSuite): ApiTestSuiteResponse {
    return {
      documentId: row.documentId,
      entityKey: row.entityKey,
      revisionId: row.revisionId,
      generatedAt: row.generatedAt.toISOString(),
      generatedBy: row.generatedBy,
      catalogueVersion: row.catalogueVersion,
      cases: row.cases as unknown as ApiTestCase[],
    };
  }

  private key(at: SuiteOperation, agentHash: string) {
    return {
      documentId: at.op.documentId,
      entityKey: at.op.entityKey,
      operationHash: at.operationHash,
      catalogueVersion: TEST_CASE_CATALOGUE_VERSION,
      agentHash,
    };
  }
}
