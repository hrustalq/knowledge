import type { PrismaService } from '../prisma/prisma.service.js';
import { revisionStamps, type RevisionStamp } from './temporal.js';

/**
 * Every finalized revision's valid-time stamp for one page (#81), read from
 * PG. The one read the processor, the BM25 repair sweep and the backfill all
 * stamp from, so the graph and the mirror cannot disagree on an interval.
 */
export async function loadRevisionStamps(prisma: PrismaService, documentId: string): Promise<RevisionStamp[]> {
  const doc = await prisma.document.findUnique({
    where: { id: documentId },
    select: {
      defaultBranch: true,
      branches: { select: { id: true, name: true } },
      revisions: { where: { finalizedAt: { not: null } }, select: { id: true, branchId: true, finalizedAt: true } },
    },
  });
  if (!doc) return [];
  return revisionStamps(doc.revisions, doc.branches.find((b) => b.name === doc.defaultBranch)?.id ?? null);
}
