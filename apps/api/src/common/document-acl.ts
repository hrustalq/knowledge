/**
 * What a store read may return, as far as page restrictions go (#76).
 *
 * `PermissionService.documentFilterFor(scope)` builds it from PG, where the
 * predicate lives; `GraphService` and the fulltext provider only apply it. It
 * is a leaf so both stores can take it without either depending on the
 * permissions module.
 *
 * - `all`: nothing to hide (an admin, a member nothing is restricted from, or a
 *   reader acting for no person).
 * - `deny`: a member — every page except `documentIds`. `nodeIds` are the
 *   restricted nodes behind that list, for stores that carry `aclNodes` stamps.
 * - `allow`: a guest — only `documentIds`.
 *
 * `pushdown` says whether the list is short enough to send to the store as a
 * predicate (`ACL_DENY_LIST_MAX`). When it is not, the store filters what it
 * scanned in memory instead — the answer is the same, the scan is not narrowed.
 */
export type DocumentAclFilter =
  | { kind: 'all' }
  | { kind: 'deny'; documentIds: ReadonlySet<string>; nodeIds: readonly string[]; pushdown: boolean }
  | { kind: 'allow'; documentIds: ReadonlySet<string>; pushdown: boolean };

/**
 * Unfiltered, for a reader acting for no person: ingestion's own context
 * reads, and the system jobs that have not been narrowed to a principal yet.
 * A constant rather than an optional argument, so every such call site is a
 * visible decision rather than a forgotten parameter.
 */
export const UNFILTERED: DocumentAclFilter = { kind: 'all' };

/** Whether `filter` lets a page with this id through. */
export function aclAdmits(filter: DocumentAclFilter, documentId: string): boolean {
  if (filter.kind === 'all') return true;
  const listed = filter.documentIds.has(documentId);
  return filter.kind === 'deny' ? !listed : listed;
}
