import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { Env } from '../config/env.js';
import { hasRealPath } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import { SiteAudienceStamper } from './site-audience.stamper.js';
import { planSiteBuild, resolveRevision, type PlanDocument, type ResolvedRevision } from './site-build.plan.js';
import { SiteSearchTextService } from './site-search-text.service.js';

/**
 * Builds one site version's snapshot (docs/features/44): reads the tree and
 * the revisions it should publish, lets `planSiteBuild` decide, and replaces
 * the version's `site_version_pages` in one transaction.
 *
 * The swap is the whole safety story. Until it commits, readers keep the
 * previous snapshot; a build that fails changes nothing they can see, and the
 * version reports `failed` beside the snapshot it still serves. The search
 * index is part of the swap (phase 2b-2): the rows carry their text and the
 * same transaction computes their vectors, so search never names a page the
 * reader does not serve, or misses one it does. So are the audience stamps
 * (phase 3): every row is written already restricted as the rules say, and a
 * restamp right after the swap closes the window in which a rule changed
 * while the build ran.
 *
 * Runs in the worker. It creates no page and attributes no act to anyone, so
 * it completes itself rather than handing anything back to the API.
 */
@Injectable()
export class SiteBuildService {
  private readonly logger = new Logger(SiteBuildService.name);
  private readonly maxPages: number;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<Env, true>,
    private readonly searchText: SiteSearchTextService,
    private readonly audiences: SiteAudienceStamper,
  ) {
    this.maxPages = config.get('SITE_MAX_PAGES', { infer: true });
  }

  async build(versionId: string): Promise<void> {
    const version = await this.prisma.siteVersion.findUnique({
      where: { id: versionId },
      include: { site: { include: { versions: { select: { id: true, slug: true } } } } },
    });
    if (!version) return; // deleted while it waited in the queue
    await this.prisma.siteVersion.update({ where: { id: versionId }, data: { status: 'building' } });

    try {
      const { site } = version;
      const documents = await this.scope(site.workspaceId, site.projectId, site.rootDocumentId);
      const revisions = await this.resolveRevisions(
        documents.map((d) => d.id),
        version.sourceBranch,
      );
      const plan = planSiteBuild({
        documents,
        revisions,
        rootDocumentId: site.rootDocumentId,
        reservedTopSegments: new Set(site.versions.map((v) => v.slug)),
        maxPages: this.maxPages,
      });

      // Read before the swap, so the transaction stays short and a snapshot
      // is never served without its search text.
      const texts = await this.searchText.texts(plan.pages.map((p) => p.revisionId));
      const rules = await this.audiences.rules(site.id);
      const pathOf = new Map(documents.map((d) => [d.id, d.path]));
      const categoryOf = new Map(documents.map((d) => [d.id, d.category]));

      await this.prisma.$transaction([
        this.prisma.siteVersionPage.deleteMany({ where: { versionId } }),
        this.prisma.siteVersionPage.createMany({
          data: plan.pages.map((p) => {
            const text = texts.get(p.revisionId);
            return {
              versionId,
              ...p,
              searchHeadings: text?.headings ?? '',
              searchBody: text?.body ?? '',
              // The facets the reader filters by (#205), frozen with the rest of the row.
              category: categoryOf.get(p.documentId) ?? 'other',
              tags: (text?.tags ?? []) as unknown as Prisma.InputJsonValue,
              ...SiteAudienceStamper.columns(this.audiences.stampFor(p.documentId, pathOf.get(p.documentId), rules)),
            };
          }),
        }),
        this.searchText.indexVersion(versionId),
        this.prisma.siteVersion.update({
          where: { id: versionId },
          data: {
            status: 'ready',
            builtAt: new Date(),
            pageCount: plan.pages.length,
            warnings: plan.warnings as unknown as Prisma.InputJsonValue,
            error: null,
          },
        }),
      ]);
      await this.audiences.restamp(site.id, versionId);
      this.logger.log(`site version ${versionId} built: ${plan.pages.length} pages, ${plan.warnings.length} warnings`);
    } catch (e) {
      const message = (e as Error).message.slice(0, 500);
      await this.prisma.siteVersion
        .update({ where: { id: versionId }, data: { status: 'failed', error: message } })
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * The live pages a site covers: the whole project, or the root page and its
   * subtree by `documents.path` (delimited at both ends, so `/a/` never
   * prefix-matches `/ab/`). A root that is gone, archived or moved to another
   * project publishes nothing rather than falling back to the whole project.
   */
  private async scope(
    workspaceId: string,
    projectId: string,
    rootDocumentId: string | null,
  ): Promise<(PlanDocument & { path: string; category: string })[]> {
    let pathPrefix: string | undefined;
    if (rootDocumentId) {
      const root = await this.prisma.document.findUnique({
        where: { id: rootDocumentId },
        select: { path: true, projectId: true, archivedAt: true },
      });
      if (!root || root.archivedAt || root.projectId !== projectId || !hasRealPath(root.path)) {
        return [];
      }
      pathPrefix = root.path;
    }
    return this.prisma.document.findMany({
      where: {
        workspaceId,
        projectId,
        archivedAt: null,
        // A site is public: a restricted page never enters a snapshot, and the
        // subtree under it inherits the restriction and stays out with it (#76).
        restrictedBy: { isEmpty: true },
        // Nor does a page that is still only a merge request (#73).
        ...LISTED_PAGE,
        ...(pathPrefix ? { path: { startsWith: pathPrefix } } : {}),
      },
      select: { id: true, parentId: true, title: true, position: true, path: true, category: true },
    });
  }

  /**
   * Per page: the branch named `sourceBranch` if the page has one, else its
   * default branch; then that branch's head if it is indexed, else the newest
   * indexed revision on it.
   */
  private async resolveRevisions(documentIds: string[], sourceBranch: string | null): Promise<Map<string, ResolvedRevision>> {
    const out = new Map<string, ResolvedRevision>();
    if (documentIds.length === 0) return out;

    const docs = await this.prisma.document.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, defaultBranch: true, branches: { select: { id: true, name: true, headRevisionId: true, restricted: true } } },
    });
    const branchFor = new Map<string, { id: string; headRevisionId: string | null }>();
    for (const doc of docs) {
      // A private branch (#474) never matches by name: the page falls back to its default branch.
      const branch =
        (sourceBranch ? doc.branches.find((b) => b.name === sourceBranch && !b.restricted) : undefined) ??
        doc.branches.find((b) => b.name === doc.defaultBranch);
      if (branch) branchFor.set(doc.id, branch);
    }

    const branches = [...branchFor.values()];
    const headIds = branches.map((b) => b.headRevisionId).filter((id): id is string => !!id);
    const heads = new Map(
      (await this.prisma.documentRevision.findMany({ where: { id: { in: headIds } }, select: { id: true, status: true } })).map(
        (r) => [r.id, r],
      ),
    );
    // Only for branches whose head cannot be published as it is.
    const fallbackBranchIds = branches
      .filter((b) => !b.headRevisionId || heads.get(b.headRevisionId)?.status !== 'indexed')
      .map((b) => b.id);
    const latestIndexed = new Map<string, { id: string }>();
    if (fallbackBranchIds.length) {
      const rows = await this.prisma.documentRevision.findMany({
        where: { branchId: { in: fallbackBranchIds }, status: 'indexed' },
        orderBy: [{ branchId: 'asc' }, { revisionNumber: 'desc' }],
        distinct: ['branchId'],
        select: { id: true, branchId: true },
      });
      for (const row of rows) if (row.branchId) latestIndexed.set(row.branchId, { id: row.id });
    }

    for (const id of documentIds) {
      const branch = branchFor.get(id);
      if (!branch) {
        out.set(id, { revisionId: null });
        continue;
      }
      const head = branch.headRevisionId ? (heads.get(branch.headRevisionId) ?? null) : null;
      out.set(id, resolveRevision(head, latestIndexed.get(branch.id) ?? null));
    }
    return out;
  }
}
