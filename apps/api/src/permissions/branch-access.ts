import type { AccessIdentity, GrantRow } from './access-scope.js';

/**
 * Private branches (#474, phase 2). A branch is a place on a page, not a node
 * in the page chain: the page's own level is decided first (`levelOn`), and
 * this only narrows it. One spelling, read in memory — a page has a handful of
 * branches, so a list filters them here rather than in SQL.
 */
export type BranchLevel = 'none' | 'view' | 'edit';

/** The columns the predicate reads. */
export interface BranchAclRow {
  id: string;
  ownerId: string | null;
  restricted: boolean;
}

/**
 * How far a private branch lets `who` in, before the page level caps it:
 *
 * - an unrestricted branch adds nothing (`edit`: the page decides);
 * - its owner and admins (who bypass) edit it;
 * - anyone else holds what their own or their groups' grants on it say;
 * - a read-only key caps it at view, as everywhere.
 */
export function branchLevel(who: AccessIdentity, branch: BranchAclRow, grants: GrantRow[]): BranchLevel {
  let level: BranchLevel;
  if (!branch.restricted || who.bypass || branch.ownerId === who.userId) {
    level = 'edit';
  } else {
    const mine = grants.filter(
      (g) =>
        g.resourceId === branch.id &&
        ((g.subjectType === 'user' && g.subjectId === who.userId) ||
          (g.subjectType === 'group' && who.groupIds.has(g.subjectId))),
    );
    level = mine.some((g) => g.level === 'edit') ? 'edit' : mine.length > 0 ? 'view' : 'none';
  }
  return who.readOnly && level === 'edit' ? 'view' : level;
}
