import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type DocumentRevision } from '@prisma/client';
import {
  CODE_SAMPLE_LANGS,
  codeSamplesFor,
  isApiSpecKind,
  normalizeEntityKey,
  type ApiOperationInfo,
  type ApiOperationSamplesResponse,
  type CodeSample,
  type CodeSampleLang,
  type ApiSpecDocumentResponse,
  type ApiSpecKind,
  type ApiSpecSummary,
  type ListApiOperationsResponse,
  type ListApiSpecsResponse,
  type SearchApiOperationsResponse,
} from '@knowledge/contracts';
import { LISTED_PAGE, listedSql } from '../common/listed-page.js';
import { t } from '../i18n/t.js';
import { visibilitySql, visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { readApiSpecDocument } from './api-spec.parser.js';
import { renderOperation } from './api-spec.projection.js';
import { ApiSpecsService } from './api-specs.service.js';

const SPEC_KINDS: ApiSpecKind[] = ['openapi', 'asyncapi'];
const SEARCH_LIMIT = 50;

type OperationRow = Prisma.ApiOperationGetPayload<object>;

/**
 * The read side of API spec documents (#78, phase 2), shared by the REST
 * routes and the MCP tools. Operation lists are SQL reads of `api_operations`;
 * only the spec itself and one operation's text read the source from S3.
 *
 * "The" operations of a spec are its default-branch head's. A head still
 * indexing has no rows yet, and says so through `revisionStatus` rather than
 * by falling back to an older revision that may name operations since removed.
 */
@Injectable()
export class ApiSpecReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly specs: ApiSpecsService,
  ) {}

  /** Spec documents in the workspace (optionally one project) the scope may open. */
  async list(scope: AccessScope, projectId?: string): Promise<ListApiSpecsResponse> {
    const docs = await this.prisma.document.findMany({
      where: {
        workspaceId: scope.workspaceId,
        kind: { in: SPEC_KINDS },
        archivedAt: null,
        ...LISTED_PAGE,
        ...(projectId ? { projectId } : {}),
        ...visibilityWhere(scope),
      },
      include: { branches: { select: { name: true, headRevisionId: true } } },
      orderBy: { title: 'asc' },
    });
    const heads = docs.map((d) => headOf(d)).filter((id): id is string => !!id);
    const [counts, revisions] = await Promise.all([
      this.prisma.apiOperation.groupBy({ by: ['revisionId'], where: { revisionId: { in: heads } }, _count: { _all: true } }),
      this.prisma.documentRevision.findMany({ where: { id: { in: heads } }, select: { id: true, status: true } }),
    ]);
    const countOf = new Map(counts.map((c) => [c.revisionId, c._count._all]));
    const statusOf = new Map(revisions.map((r) => [r.id, r.status]));
    const specs: ApiSpecSummary[] = docs.map((d) => {
      const head = headOf(d);
      return {
        documentId: d.id,
        projectId: d.projectId,
        title: d.title,
        kind: d.kind as ApiSpecKind,
        slug: d.specSlug,
        headRevisionId: head,
        headRevisionStatus: head ? (statusOf.get(head) ?? null) : null,
        operationCount: head ? (countOf.get(head) ?? 0) : 0,
        createdAt: d.createdAt.toISOString(),
      };
    });
    return { specs };
  }

  /** One revision's spec, parsed (the head unless `revisionId` is given). */
  async spec(documentId: string, revisionId?: string): Promise<ApiSpecDocumentResponse> {
    const { doc, revision } = await this.revisionOf(documentId, revisionId);
    if (!revision) throw new NotFoundException(t('error.document.noRevisions', { id: documentId }));
    if (revision.status === 'draft') throw new BadRequestException(t('error.document.contentIsDraft', { id: revision.id }));
    const raw = await this.storage.getObjectText(revision.s3Key);
    const { document, specVersion } = readApiSpecDocument(raw, doc.kind);
    const info = (document.info ?? {}) as Record<string, unknown>;
    return {
      documentId,
      revisionId: revision.id,
      kind: doc.kind,
      specVersion,
      title: typeof info.title === 'string' ? info.title : doc.title,
      version: typeof info.version === 'string' ? info.version : null,
      slug: doc.specSlug,
      document,
    };
  }

  /** The operations of one revision, in spec order. */
  async operations(documentId: string, revisionId?: string): Promise<ListApiOperationsResponse> {
    const { revision } = await this.revisionOf(documentId, revisionId);
    const rows = revision
      ? await this.prisma.apiOperation.findMany({ where: { revisionId: revision.id }, orderBy: { createdAt: 'asc' } })
      : [];
    return {
      documentId,
      revisionId: revision?.id ?? null,
      revisionStatus: revision?.status ?? null,
      operations: rows.map(toInfo),
    };
  }

  /**
   * Operations across every spec the scope may open, at each spec's head —
   * the "Link API operation" picker and `knowledge_list_api_operations`.
   * Matches method + path, summary, operationId and the key, case-insensitively.
   */
  async search(
    scope: AccessScope,
    opts: { q?: string; documentId?: string; limit?: number },
  ): Promise<SearchApiOperationsResponse> {
    const limit = Math.min(Math.max(opts.limit ?? SEARCH_LIMIT, 1), 200);
    const q = opts.q?.trim();
    const like = q ? `%${q.replace(/[\\%_]/gu, (c) => `\\${c}`)}%` : null;
    const rows = await this.prisma.$queryRaw<Array<OperationRow & { specTitle: string }>>`
      SELECT o.id, o.workspace_id AS "workspaceId", o.document_id AS "documentId", o.revision_id AS "revisionId",
             o.protocol, o.method, o.path, o.operation_id AS "operationId", o.entity_key AS "entityKey",
             o.summary, o.tags, o.deprecated, o.pointer, o.created_at AS "createdAt", d.title AS "specTitle"
        FROM api_operations o
        JOIN documents d ON d.id = o.document_id
        JOIN document_branches b ON b.document_id = d.id AND b.name = d.default_branch AND b.head_revision_id = o.revision_id
       WHERE o.workspace_id = ${scope.workspaceId}::uuid
         AND d.archived_at IS NULL
         AND ${listedSql('d')}
         AND ${visibilitySql(scope, 'd')}
         ${opts.documentId ? Prisma.sql`AND d.id = ${opts.documentId}::uuid` : Prisma.empty}
         ${
           like
             ? Prisma.sql`AND (coalesce(o.method, '') || ' ' || o.path ILIKE ${like} OR o.summary ILIKE ${like}
                 OR o.operation_id ILIKE ${like} OR o.entity_key ILIKE ${like})`
             : Prisma.empty
         }
       ORDER BY d.title, o.created_at
       LIMIT ${limit}`;
    return { operations: rows.map((r) => ({ ...toInfo(r), specTitle: r.specTitle })) };
  }

  /**
   * One operation's code samples (#78, phase 4): the author's `x-codeSamples`
   * where the spec has them, generated from the operation elsewhere, with
   * placeholders for every credential.
   */
  async samples(
    documentId: string,
    opts: { entityKey: string; method?: string; lang?: CodeSampleLang; revisionId?: string },
  ): Promise<ApiOperationSamplesResponse> {
    const { revision } = await this.revisionOf(documentId, opts.revisionId);
    const spec = await this.spec(documentId, revision?.id);
    const entityKey = normalizeEntityKey(opts.entityKey);
    const row = await this.prisma.apiOperation.findFirst({
      where: { revisionId: spec.revisionId, entityKey, ...(opts.method ? { method: opts.method.toUpperCase() } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    if (!row) throw new NotFoundException(t('error.apiTry.operationNotInSpec', { method: opts.method ?? '', entityKey }));
    return {
      documentId,
      revisionId: spec.revisionId,
      entityKey,
      samples: codeSamplesFor(spec.document, row, {}, opts.lang ? [opts.lang] : CODE_SAMPLE_LANGS),
    };
  }

  /**
   * One operation by entity key, at the head of a spec the scope may open, with
   * its section of the projection — the spec author's text, which the caller
   * must wrap as untrusted before a model sees it.
   */
  async operation(
    scope: AccessScope,
    entityKey: string,
    documentId?: string,
    lang?: CodeSampleLang,
  ): Promise<{ operations: Array<ApiOperationInfo & { specTitle: string; markdown: string; samples?: CodeSample[] }> } | null> {
    const hits = (await this.search(scope, { documentId, limit: 200 })).operations.filter((o) => o.entityKey === entityKey);
    if (hits.length === 0) return null;
    const out: Array<ApiOperationInfo & { specTitle: string; markdown: string; samples?: CodeSample[] }> = [];
    for (const hit of hits.slice(0, 5)) {
      const revision = await this.prisma.documentRevision.findUnique({ where: { id: hit.revisionId } });
      const doc = await this.prisma.document.findUnique({ where: { id: hit.documentId }, select: { kind: true } });
      if (!revision || !doc || !isApiSpecKind(doc.kind)) continue;
      const spec = await this.specs.parse(await this.storage.getObjectText(revision.s3Key), doc.kind);
      // The pointer is stable within a revision, so it finds the operation
      // without re-deriving a key under a slug that may have been re-pinned.
      const op = spec.operations.find((o) => o.pointer === hit.pointer && o.method === hit.method);
      out.push({
        ...hit,
        markdown: op ? renderOperation(op) : '',
        ...(lang ? { samples: codeSamplesFor(spec.document, hit, {}, [lang]) } : {}),
      });
    }
    return { operations: out };
  }

  private async revisionOf(
    documentId: string,
    revisionId?: string,
  ): Promise<{ doc: { kind: ApiSpecKind; title: string; specSlug: string | null }; revision: DocumentRevision | null }> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      include: { branches: { select: { name: true, headRevisionId: true } } },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    if (!isApiSpecKind(doc.kind)) throw new BadRequestException(t('error.apiSpec.notSpec', { id: documentId }));
    const id = revisionId ?? headOf(doc);
    const revision = id ? await this.prisma.documentRevision.findUnique({ where: { id } }) : null;
    if (revisionId && (!revision || revision.documentId !== documentId)) {
      throw new NotFoundException(t('error.revision.notFoundOnDocument', { revisionId, documentId }));
    }
    return { doc: { kind: doc.kind, title: doc.title, specSlug: doc.specSlug }, revision };
  }
}

function headOf(doc: { defaultBranch: string; branches: Array<{ name: string; headRevisionId: string | null }> }): string | null {
  return doc.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId ?? null;
}

function toInfo(r: OperationRow): ApiOperationInfo {
  return {
    documentId: r.documentId,
    revisionId: r.revisionId,
    protocol: r.protocol as ApiOperationInfo['protocol'],
    method: r.method,
    path: r.path,
    operationId: r.operationId,
    entityKey: r.entityKey,
    summary: r.summary,
    tags: r.tags,
    deprecated: r.deprecated,
    pointer: r.pointer,
  };
}
