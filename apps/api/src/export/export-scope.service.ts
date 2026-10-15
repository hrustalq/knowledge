import { Injectable } from '@nestjs/common';
import type { ExportScope, Locale } from '@knowledge/contracts';
import { hasRealPath } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PlanDocument } from '../publishing/site-build.plan.js';
import { AccessService } from '../auth/access.service.js';
import type { Principal } from '../auth/principal.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere } from '../permissions/access-scope.js';

export interface ExportScopeInput {
  workspaceId: string;
  scope: ExportScope;
  documentId: string | null;
  projectId: string | null;
  /**
   * Whose export it is: the principal on the API side, the stored
   * `requested_by` (with the job's locale) in the worker. The pages are the
   * ones that person may open, asked again when the job runs (#76).
   */
  requester: Principal | { userId: string; locale: Locale };
}

export interface ScopeDocument extends PlanDocument {
  category: string;
}

/** The revision a page exports, and the branch it came from. */
export interface ExportRevision {
  revisionId: string;
  branch: string;
}

/**
 * Which pages an export covers and which revision of each it writes
 * (docs/features/45). Shared by the API, which counts the scope before it
 * queues anything, and the worker, which reads it again when the job runs —
 * pages added in between are in, and the page cap is checked a second time.
 */
@Injectable()
export class ExportScopeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
    private readonly permissions: PermissionService,
  ) {}

  /**
   * The live (unarchived) pages in scope that the requester may open: one page, a page and its subtree by
   * `documents.path` (delimited at both ends, so `/a/` never prefix-matches
   * `/ab/`), or every page of a project.
   */
  async documents(input: ExportScopeInput): Promise<ScopeDocument[]> {
    const select = { id: true, parentId: true, title: true, position: true, category: true } as const;
    const principal =
      'mode' in input.requester
        ? input.requester
        : await this.access.principalFor(input.requester.userId, input.requester.locale);
    const visible = visibilityWhere(await this.permissions.scopeFor(principal, input.workspaceId));
    if (input.scope === 'project') {
      if (!input.projectId) return [];
      return this.prisma.document.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, archivedAt: null, AND: [visible] },
        select,
      });
    }
    if (!input.documentId) return [];
    const root = await this.prisma.document.findFirst({
      where: { id: input.documentId, AND: [visible] },
      select: { ...select, workspaceId: true, path: true, archivedAt: true },
    });
    if (!root || root.workspaceId !== input.workspaceId || root.archivedAt) return [];
    if (input.scope === 'page' || !hasRealPath(root.path)) {
      return [{ id: root.id, parentId: root.parentId, title: root.title, position: root.position, category: root.category }];
    }
    return this.prisma.document.findMany({
      where: { workspaceId: input.workspaceId, archivedAt: null, path: { startsWith: root.path }, AND: [visible] },
      select,
    });
  }

  /**
   * Per page: the branch named `branch` if the page has one, else its default
   * branch (the rule site versions follow); then that branch's head unless it
   * is still a draft, else the newest revision on it that is not. A member's
   * export shows what a member reads — a head that is still indexing, or whose
   * indexing failed, has its content all the same.
   */
  async revisions(documentIds: string[], branch: string | null): Promise<Map<string, ExportRevision>> {
    const out = new Map<string, ExportRevision>();
    if (documentIds.length === 0) return out;

    const docs = await this.prisma.document.findMany({
      where: { id: { in: documentIds } },
      select: { id: true, defaultBranch: true, branches: { select: { id: true, name: true, headRevisionId: true } } },
    });
    const branchFor = new Map<string, { id: string; name: string; headRevisionId: string | null }>();
    for (const doc of docs) {
      const chosen =
        (branch ? doc.branches.find((b) => b.name === branch) : undefined) ??
        doc.branches.find((b) => b.name === doc.defaultBranch);
      if (chosen) branchFor.set(doc.id, chosen);
    }

    const branches = [...branchFor.values()];
    const headIds = branches.map((b) => b.headRevisionId).filter((id): id is string => !!id);
    const heads = new Map(
      (await this.prisma.documentRevision.findMany({ where: { id: { in: headIds } }, select: { id: true, status: true } })).map(
        (r) => [r.id, r],
      ),
    );
    const fallbackBranchIds = branches
      .filter((b) => !b.headRevisionId || (heads.get(b.headRevisionId)?.status ?? 'draft') === 'draft')
      .map((b) => b.id);
    const latest = new Map<string, string>();
    if (fallbackBranchIds.length) {
      const rows = await this.prisma.documentRevision.findMany({
        where: { branchId: { in: fallbackBranchIds }, status: { not: 'draft' } },
        orderBy: [{ branchId: 'asc' }, { revisionNumber: 'desc' }],
        distinct: ['branchId'],
        select: { id: true, branchId: true },
      });
      for (const row of rows) if (row.branchId) latest.set(row.branchId, row.id);
    }

    for (const [documentId, b] of branchFor) {
      const head = b.headRevisionId ? heads.get(b.headRevisionId) : undefined;
      const revisionId = head && head.status !== 'draft' ? head.id : latest.get(b.id);
      if (revisionId) out.set(documentId, { revisionId, branch: b.name });
    }
    return out;
  }
}
