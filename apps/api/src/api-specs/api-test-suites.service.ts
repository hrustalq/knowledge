import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApiOperation, ApiTestSuite, Prisma } from '@prisma/client';
import {
  TEST_CASE_CATALOGUE_VERSION,
  normalizeEntityKey,
  operationFingerprint,
  testCasesFor,
  type ApiSpecDocumentResponse,
  type ApiTestCase,
  type ApiTestSuiteResponse,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ApiSpecReadService } from './api-spec-read.service.js';

/** One HTTP operation at one spec revision, with the operation half of its suite's cache key. */
export interface SuiteOperation {
  spec: ApiSpecDocumentResponse;
  op: ApiOperation;
  /** SHA-256 of `operationFingerprint`: unchanged by spec edits that do not reach this operation. */
  operationHash: string;
  /** The fixtures bound to the suite (#483), suite-level first, in run order. */
  bindings: SuiteBinding[];
  /** The bindings' half of the cache key: '' for none. */
  fixturesHash: string;
}

/** One fixture bound to a suite, with its default-branch head as it stands now. */
export interface SuiteBinding {
  /** Null for the whole suite. */
  caseId: string | null;
  fixtureId: string;
  title: string;
  headRevisionId: string | null;
  /** The head's content hash, which is what the cache key reads. */
  contentHash: string | null;
  archived: boolean;
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
    const bindings = await this.bindingsOf(op.documentId, op.entityKey);
    return { spec, op, operationHash: operationHash(spec.document, op), bindings, fixturesHash: fixturesHash(bindings) };
  }

  /** The fixtures bound to one operation's suite, in run order. A binding outlives Regenerate and spec edits. */
  async bindingsOf(documentId: string, entityKey: string): Promise<SuiteBinding[]> {
    return this.bindingsWhere({ documentId, entityKey: normalizeEntityKey(entityKey) });
  }

  /** Every suite's bindings across these specs (the QA overview), keyed by `suiteId`, each list in run order. */
  async bindingsOfSpecs(documentIds: string[]): Promise<Map<string, SuiteBinding[]>> {
    const out = new Map<string, SuiteBinding[]>();
    for (const b of await this.bindingsWhere({ documentId: { in: documentIds } })) {
      const id = suiteId(b.documentId, b.entityKey);
      out.set(id, [...(out.get(id) ?? []), b]);
    }
    return out;
  }

  private async bindingsWhere(where: Prisma.ApiTestBindingWhereInput): Promise<Array<SuiteBinding & { documentId: string; entityKey: string }>> {
    const rows = await this.prisma.apiTestBinding.findMany({
      where,
      orderBy: [{ documentId: 'asc' }, { entityKey: 'asc' }, { caseId: { sort: 'asc', nulls: 'first' } }, { position: 'asc' }],
      include: { fixture: { select: { title: true, defaultBranch: true, archivedAt: true, branches: { select: { name: true, headRevisionId: true } } } } },
    });
    const heads = rows.map((r) => r.fixture.branches.find((b) => b.name === r.fixture.defaultBranch)?.headRevisionId ?? null);
    const ids = heads.filter((h): h is string => h !== null);
    const hashes = new Map(
      (await this.prisma.documentRevision.findMany({ where: { id: { in: ids } }, select: { id: true, contentHash: true } })).map((r) => [r.id, r.contentHash]),
    );
    return rows.map((r, i) => ({
      documentId: r.documentId,
      entityKey: r.entityKey,
      caseId: r.caseId,
      fixtureId: r.fixtureId,
      title: r.fixture.title,
      headRevisionId: heads[i],
      contentHash: heads[i] ? (hashes.get(heads[i]) ?? heads[i]) : null,
      archived: r.fixture.archivedAt !== null,
    }));
  }

  /**
   * Replace one suite's bindings with `list`, in that order — what a person
   * confirms. Every fixture must be a `test-fixture` the caller can open in
   * the spec's workspace, and every case id one the suite's catalogue lists.
   */
  async setBindings(
    scope: AccessScope,
    at: SuiteOperation,
    list: ReadonlyArray<{ caseId: string | null; fixtureId: string }>,
    userId: string,
  ): Promise<SuiteBinding[]> {
    const ids = [...new Set(list.map((b) => b.fixtureId))];
    const found = await this.prisma.document.findMany({
      where: { id: { in: ids }, workspaceId: at.op.workspaceId, kind: 'test-fixture', archivedAt: null, ...visibilityWhere(scope) },
      select: { id: true },
    });
    const missing = ids.filter((id) => !found.some((d) => d.id === id));
    if (missing.length) throw new BadRequestException(t('error.apiTestSuite.bindingFixture', { id: missing[0] }));
    const cases = new Set(testCasesFor(at.spec.document, at.op).map((c) => c.id));
    const unknown = list.find((b) => b.caseId !== null && !cases.has(b.caseId));
    if (unknown) throw new BadRequestException(t('error.apiTestSuite.bindingCase', { caseId: unknown.caseId! }));

    const rows = [...new Map(list.map((b) => [`${b.caseId ?? ''}\u0000${b.fixtureId}`, b])).values()];
    const where = { documentId: at.op.documentId, entityKey: at.op.entityKey };
    await this.prisma.$transaction([
      this.prisma.apiTestBinding.deleteMany({ where }),
      this.prisma.apiTestBinding.createMany({
        data: rows.map((b) => ({
          ...where,
          workspaceId: at.op.workspaceId,
          caseId: b.caseId,
          fixtureId: b.fixtureId,
          position: rows.filter((x) => x.caseId === b.caseId).indexOf(b),
          createdBy: userId,
        })),
      }),
    ]);
    return this.bindingsOf(at.op.documentId, at.op.entityKey);
  }

  find(at: SuiteOperation, agentHash: string): Promise<ApiTestSuite | null> {
    return this.prisma.apiTestSuite.findUnique({ where: { suiteKey: this.key(at, agentHash) } });
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
      where: { suiteKey: key },
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
      fixturesHash: at.fixturesHash,
    };
  }
}

/** One suite's identity within a workspace: its spec and operation. */
export const suiteId = (documentId: string, entityKey: string) => `${documentId}\u0000${entityKey}`;

/** The operation half of the cache key: unchanged by spec edits that do not reach this operation. */
export function operationHash(doc: Record<string, unknown>, op: ApiOperation): string {
  return createHash('sha256').update(operationFingerprint(doc, op)).digest('hex');
}

/** Which fixture heads a suite was built against, as one hash; '' when nothing is bound, so an unbound suite keeps its key. */
export function fixturesHash(bindings: readonly SuiteBinding[]): string {
  if (!bindings.length) return '';
  return createHash('sha256')
    .update(JSON.stringify(bindings.map((b) => [b.caseId, b.fixtureId, b.contentHash])))
    .digest('hex');
}
