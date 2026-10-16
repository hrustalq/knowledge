import type { Prisma } from '@prisma/client';
import { LISTED_PAGE } from '../common/listed-page.js';

/**
 * Which pages a principal may read as AI-readable output (docs: issue #68).
 *
 * The ONE place the Publishing milestone will widen. Every surface of this
 * feature — the `.md` page read, `llms.txt`, `llms-full.txt` and the MCP
 * resources — derives its row set from these two exports, so they cannot
 * disagree about what is readable ("a declaration is not a fact").
 *
 * Authorization has already happened by the time this runs: `@Access` in
 * `AclGuard` (role + API-key narrowing) resolves the id to its workspace and
 * 403s a cross-tenant caller before the handler. This predicate only says which
 * rows *inside* that authorized scope are exported. Publishing will add a
 * `visibility`-style clause here and call it from an anonymous route.
 *
 * A leaf module: no Nest, no Prisma client, no I/O.
 */
export interface AiReadableScope {
  workspaceId: string;
  projectId?: string;
  documentId?: string;
}

/**
 * Head statuses whose bytes are exported. Everything past `draft`: a `failed`
 * revision failed *indexing*, its content is finalized and hashed and is what
 * the page view shows, so hiding it from an agent would make the two disagree.
 * A draft is never exported — it is not content yet.
 */
export const READABLE_REVISION_STATUSES = ['finalized', 'indexing', 'indexed', 'failed'] as const;

export function isReadableRevisionStatus(status: string): boolean {
  return (READABLE_REVISION_STATUSES as readonly string[]).includes(status);
}

/**
 * Restrictions (#76): the workspace and project listings carry only pages that
 * are open to the whole workspace — `restricted_by` empty, which also rules out
 * every page of a restricted project. They are one document read by many
 * agents and cached by ETag, so they cannot be cut per reader. A single page
 * (`documentId`) is different: AclGuard has already checked that page for
 * this caller, so a restricted page they may open still reads as markdown.
 */
export function readableDocumentsWhere(scope: AiReadableScope): Prisma.DocumentWhereInput {
  const where: Prisma.DocumentWhereInput = { workspaceId: scope.workspaceId };
  if (scope.projectId) where.projectId = scope.projectId;
  if (scope.documentId) where.id = scope.documentId;
  else {
    where.restrictedBy = { isEmpty: true };
    // A page still behind its first merge request is not listed (#73).
    where.pendingMergeRequestId = LISTED_PAGE.pendingMergeRequestId;
  }
  return where;
}

/** The projects a listing names: a restricted one is not named at all (#76). */
export function listedProjectsWhere(workspaceId: string): Prisma.ProjectWhereInput {
  return { workspaceId, restricted: false };
}
