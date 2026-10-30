import type { DocumentBranch } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The page branches a merge request from `source` carries (#636): every page
 * of its project branch with a revision of its own, and `source` itself, the
 * page it was opened from, first. A branch only forked onto a page and never
 * written there changes nothing on it. A page branch with no project branch
 * yet (one the previous image created) is its own set.
 */
export async function sourcePages(
  prisma: PrismaService,
  source: Pick<DocumentBranch, 'id' | 'projectBranchId'>,
): Promise<DocumentBranch[]> {
  const rows = await prisma.documentBranch.findMany({
    where: source.projectBranchId
      ? {
          projectBranchId: source.projectBranchId,
          OR: [{ id: source.id }, { revisions: { some: { status: { not: 'draft' } } } }],
        }
      : { id: source.id },
    orderBy: { documentId: 'asc' },
  });
  return rows.sort((a, b) => Number(b.id === source.id) - Number(a.id === source.id));
}
