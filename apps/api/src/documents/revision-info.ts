import type { DocumentRevision } from '@prisma/client';
import type { RevisionInfo, RevisionStatus } from '@knowledge/contracts';

/** A revision row as the API reports it. One copy: DocumentsService and MergeRequestsService both answer with it. */
export function toRevisionInfo(r: DocumentRevision): RevisionInfo {
  return {
    revisionId: r.id,
    documentId: r.documentId,
    revisionNumber: r.revisionNumber,
    contentHash: r.contentHash,
    contentType: r.contentType,
    status: r.status as RevisionStatus,
    message: r.message,
    createdAt: r.createdAt.toISOString(),
    finalizedAt: r.finalizedAt?.toISOString() ?? null,
    coAuthorIds: Array.isArray(r.coAuthorIds) ? (r.coAuthorIds as string[]) : [],
  };
}
