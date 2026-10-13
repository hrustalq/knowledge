import { Injectable } from '@nestjs/common';
import type { ExportScope } from '@knowledge/contracts';
import { hasRealPath } from '../documents/documents.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PlanDocument } from '../publishing/site-build.plan.js';

export interface ExportScopeInput {
  workspaceId: string;
  scope: ExportScope;
  documentId: string | null;
  projectId: string | null;
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
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The live (unarchived) pages in scope: one page, a page and its subtree by
   * `documents.path` (delimited at both ends, so `/a/` never prefix-matches
   * `/ab/`), or every page of a project.
   */
  async documents(input: ExportScopeInput): Promise<ScopeDocument[]> {
    const select = { id: true, parentId: true, title: true, position: true, category: true } as const;
    if (input.scope === 'project') {
      if (!input.projectId) return [];
      return this.prisma.document.findMany({
        where: { workspaceId: input.workspaceId, projectId: input.projectId, archivedAt: null },
        select,
      });
    }
    if (!input.documentId) return [];
    const root = await this.prisma.document.findUnique({
      where: { id: input.documentId },
      select: { ...select, workspaceId: true, path: true, archivedAt: true },
    });
    if (!root || root.workspaceId !== input.workspaceId || root.archivedAt) return [];
    if (input.scope === 'page' || !hasRealPath(root.path)) {
      return [{ id: root.id, parentId: root.parentId, title: root.title, position: root.position, category: root.category }];
    }
    return this.prisma.document.findMany({
      where: { workspaceId: input.workspaceId, archivedAt: null, path: { startsWith: root.path } },
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
