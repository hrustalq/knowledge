import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { apiSpecSlug, type ApiSpecKind } from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { t } from '../i18n/t.js';
import { ApiSpecError, keyOperations, parseApiSpec, type ParsedApiSpec, type ParsedOperation } from './api-spec.parser.js';
import { renderSpecProjection } from './api-spec.projection.js';

/** What ingestion indexes for a spec revision, in place of a markdown body. */
export interface ApiSpecProjection {
  spec: ParsedApiSpec;
  slug: string;
  operations: Array<ParsedOperation & { entityKey: string }>;
  markdown: string;
}

/**
 * API spec documents (#78) on both sides of the queue: the API refuses an
 * invalid spec at finalize, and the worker projects a valid one at ingestion.
 * Both parse with the same function, so a spec that finalized cannot fail to
 * parse in the worker for any reason but a limit lowered in between.
 */
@Injectable()
export class ApiSpecsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Parse with the configured limits; a bad spec is the parser's own error. */
  parse(raw: string, kind: ApiSpecKind): Promise<ParsedApiSpec> {
    return parseApiSpec(raw, kind, {
      maxBytes: this.config.get('API_SPEC_MAX_BYTES', { infer: true }),
      maxOperations: this.config.get('API_SPEC_MAX_OPERATIONS', { infer: true }),
    });
  }

  /**
   * The finalize check: a 422 whose `details.issues` are the validator's
   * messages, flat extras per house style (the filter hoists them).
   */
  async assertValid(raw: string, kind: ApiSpecKind): Promise<ParsedApiSpec> {
    try {
      return await this.parse(raw, kind);
    } catch (e) {
      if (!(e instanceof ApiSpecError)) throw e;
      throw new UnprocessableEntityException({
        statusCode: 422,
        message: t('error.apiSpec.parseFailed', { reason: e.issues[0]?.message ?? e.message }),
        issues: e.issues,
      });
    }
  }

  /**
   * Parse a revision, resolve its slug, and replace the revision's
   * `api_operations` rows. Idempotent per revision, like every other step of
   * the ingestion job, so a retry rewrites the same rows.
   *
   * The slug is pinned on the document the first time any revision is
   * projected, so a later `info.title` edit keys nothing new. An explicit
   * `x-knowledge-key` re-pins it, but only from the default-branch head: a
   * branch may propose a new key — its own operations carry it, and the diff
   * shows every operation moving — without moving the live entities first.
   */
  async project(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    kind: ApiSpecKind;
    raw: string;
    live: boolean;
  }): Promise<ApiSpecProjection> {
    const spec = await this.parse(input.raw, input.kind);
    const slug = await this.resolveSlug(input.documentId, spec, input.live);
    const operations = keyOperations(spec, slug);

    await this.prisma.withTransaction(async () => {
      await this.prisma.apiOperation.deleteMany({ where: { revisionId: input.revisionId } });
      await this.prisma.apiOperation.createMany({
        data: operations.map((op) => ({
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          revisionId: input.revisionId,
          protocol: op.protocol,
          method: op.method,
          path: op.path,
          operationId: op.operationId,
          entityKey: op.entityKey,
          summary: op.summary,
          tags: op.tags,
          deprecated: op.deprecated,
          pointer: op.pointer,
        })),
      });
    });
    return { spec, slug, operations, markdown: renderSpecProjection(spec, operations) };
  }

  private async resolveSlug(documentId: string, spec: ParsedApiSpec, live: boolean): Promise<string> {
    const hint = spec.keyHint ? apiSpecSlug(spec.keyHint) : null;
    const doc = await this.prisma.document.findUnique({ where: { id: documentId }, select: { specSlug: true } });
    const pinned = doc?.specSlug ?? null;
    if (pinned && !hint) return pinned;
    if (pinned && hint && !live) return hint;
    if (pinned && hint === pinned) return pinned;
    if (pinned && hint) {
      await this.prisma.document.update({ where: { id: documentId }, data: { specSlug: hint } });
      return hint;
    }
    // First projection. Guarded on null so two jobs racing pin one slug, and
    // both then key under whichever won.
    const candidate = hint ?? apiSpecSlug(spec.title);
    await this.prisma.document.updateMany({ where: { id: documentId, specSlug: null }, data: { specSlug: candidate } });
    const after = await this.prisma.document.findUnique({ where: { id: documentId }, select: { specSlug: true } });
    return after?.specSlug ?? candidate;
  }
}
