import type { Prisma } from '@prisma/client';
import type { VisibilityRow } from '../src/permissions/access-scope.js';

export type WhereRow = VisibilityRow & { id: string; workspaceId?: string };

/**
 * Just the Prisma operators the page-permission code emits (#76), evaluated
 * over one row — so a spec can run `visibilityWhere` and the filters built on
 * it against fixtures instead of trusting a mock to agree with them.
 */
export function matchesWhere(where: Prisma.DocumentWhereInput, row: WhereRow): boolean {
  return Object.entries(where).every(([key, value]) => {
    const v = value as Record<string, unknown>;
    switch (key) {
      case 'AND':
        return (value as Prisma.DocumentWhereInput[]).every((w) => matchesWhere(w, row));
      case 'OR':
        return (value as Prisma.DocumentWhereInput[]).some((w) => matchesWhere(w, row));
      case 'NOT':
        return !matchesWhere(value as Prisma.DocumentWhereInput, row);
      case 'restrictedBy':
        return (v.hasSome as string[]).some((id) => row.restrictedBy.includes(id));
      case 'projectId':
        return (v.in as string[]).includes(row.projectId);
      case 'path':
        return row.path.includes(v.contains as string);
      case 'id':
        return (v.in as string[]).includes(row.id);
      case 'workspaceId':
        return row.workspaceId === undefined || row.workspaceId === value;
      default:
        throw new Error(`a where clause used an operator this helper does not model: ${key}`);
    }
  });
}
