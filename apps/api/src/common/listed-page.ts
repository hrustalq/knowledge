import { Prisma } from '@prisma/client';

/**
 * Pages a list shows (issue #73, Option A). A page created head-less behind a
 * merge request — an agent capture, a chat save — is the merge request's until
 * it merges: readable by id so its reviewer can open it, but absent from every
 * surface that enumerates pages (tree, lists, knowledge health, export, sites,
 * llms.txt). The merge clears `pending_merge_request_id`; a closed one leaves
 * the empty stub hidden, so reopening it still works.
 *
 * Not part of `visibilityWhere`: that is who may open a page, and a merge
 * request list must keep showing the merge request whose page this is.
 */
export const LISTED_PAGE = { pendingMergeRequestId: null } as const satisfies Prisma.DocumentWhereInput;

/** `LISTED_PAGE` for raw SQL over `documents <alias>`. `alias` is a fixed identifier from the call site. */
export function listedSql(alias: string): Prisma.Sql {
  return Prisma.sql`${Prisma.raw(alias)}.pending_merge_request_id IS NULL`;
}
