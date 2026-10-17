import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  apiSpecSlug,
  isApiSpecKind,
  resolveApiBreakingChangePolicy,
  type ApiBreakingChangePolicy,
  type ApiSpecDiff,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { t } from '../i18n/t.js';
import { diffApiSpecs } from './api-diff.js';
import { ApiSpecError, type ParsedApiSpec } from './api-spec.parser.js';
import { ApiSpecsService } from './api-specs.service.js';

/**
 * Versioned with the rules: a cached row is an answer from the classifier
 * that wrote it, so a rule change bumps this rather than serving stale verdicts.
 */
const DIFF_FORMAT = 'api-semantic-v1';

/**
 * The classified diff between two revisions of a spec document (#78, phase 6),
 * cached in `revision_diffs` like the line and structural diffs: finalized
 * revisions are immutable, so a row once written is always right.
 *
 * Core, so the merge gate, the compare route and the MCP tool read one
 * answer. The verdict is derived from this diff on every read and never
 * stored on the merge request.
 */
@Injectable()
export class ApiSpecDiffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly specs: ApiSpecsService,
  ) {}

  /**
   * `from` → `to`; `from` null diffs against nothing, so every operation is
   * added. Null when the document is not a spec, or either side no longer
   * parses (a limit lowered since it was indexed): no verdict is better than
   * a wrong one.
   */
  async diff(documentId: string, fromRevisionId: string | null, toRevisionId: string): Promise<ApiSpecDiff | null> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { kind: true, specSlug: true },
    });
    if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
    if (!isApiSpecKind(doc.kind)) return null;

    if (fromRevisionId === toRevisionId) {
      return { documentId, fromRevisionId, toRevisionId, summary: { breaking: 0, nonBreaking: 0, info: 0 }, changes: [] };
    }
    if (fromRevisionId) {
      const cached = await this.prisma.revisionDiff.findUnique({
        where: { fromRevisionId_toRevisionId_format: { fromRevisionId, toRevisionId, format: DIFF_FORMAT } },
      });
      if (cached) return { documentId, fromRevisionId, toRevisionId, ...(cached.changes as unknown as Pick<ApiSpecDiff, 'summary' | 'changes'>) };
    }

    const [before, after] = await Promise.all([
      fromRevisionId ? this.parseRevision(documentId, fromRevisionId, doc.kind) : Promise.resolve(null),
      this.parseRevision(documentId, toRevisionId, doc.kind),
    ]);
    if (!after || (fromRevisionId && !before)) return null;

    // One slug for both sides: the pinned one. A branch proposing a new
    // `x-knowledge-key` re-keys no operation in its own diff — a client calls
    // the same method and path either way.
    const slug = doc.specSlug ?? apiSpecSlug(after.keyHint ?? after.title);
    const result = diffApiSpecs(before, after, slug);

    if (fromRevisionId) {
      await this.prisma.revisionDiff
        .create({
          data: {
            fromRevisionId,
            toRevisionId,
            format: DIFF_FORMAT,
            additions: result.summary.nonBreaking + result.summary.info,
            deletions: result.summary.breaking,
            changes: result as unknown as object,
          },
        })
        .catch(() => {
          /* unique race with a concurrent diff — the row already exists */
        });
    }
    return { documentId, fromRevisionId, toRevisionId, ...result };
  }

  /**
   * The route and MCP form: `to` defaults to the default-branch head, and a
   * page document or a side that no longer parses is a 400, not a null.
   */
  async require(documentId: string, fromRevisionId: string, toRevisionId?: string): Promise<ApiSpecDiff> {
    let to = toRevisionId;
    if (!to) {
      const doc = await this.prisma.document.findUnique({
        where: { id: documentId },
        select: { defaultBranch: true, branches: { select: { name: true, headRevisionId: true } } },
      });
      if (!doc) throw new NotFoundException(t('error.document.notFound', { id: documentId }));
      to = doc.branches.find((b) => b.name === doc.defaultBranch)?.headRevisionId ?? undefined;
      if (!to) throw new NotFoundException(t('error.document.noRevisions', { id: documentId }));
    }
    const diff = await this.diff(documentId, fromRevisionId, to);
    if (!diff) throw new BadRequestException(t('error.apiSpec.notDiffable', { id: documentId }));
    return diff;
  }

  /** The workspace's merge-gate policy: the sparse row over the `warn` default. */
  async breakingPolicy(workspaceId: string): Promise<ApiBreakingChangePolicy> {
    const row = await this.prisma.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { apiBreakingChangePolicy: true },
    });
    return resolveApiBreakingChangePolicy(row?.apiBreakingChangePolicy);
  }

  private async parseRevision(documentId: string, revisionId: string, kind: 'openapi' | 'asyncapi'): Promise<ParsedApiSpec | null> {
    const revision = await this.prisma.documentRevision.findUnique({ where: { id: revisionId } });
    if (!revision || revision.documentId !== documentId) {
      throw new NotFoundException(t('error.revision.notFoundOnDocument', { revisionId, documentId }));
    }
    if (!revision.contentHash) {
      throw new BadRequestException(
        t('error.revision.notComparable', { id: revisionId, status: t(`status.revision.${revision.status}`) }),
      );
    }
    try {
      return await this.specs.parse(await this.storage.getObjectText(revision.s3Key), kind);
    } catch (e) {
      if (e instanceof ApiSpecError) return null;
      throw e;
    }
  }
}
