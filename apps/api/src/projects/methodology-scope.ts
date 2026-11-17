import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * What a project sees through its methodology (#1121).
 *
 * Rows a project lists come from three scopes, in this order on a name clash:
 * the project's own (`project_id`), its methodology's (`blueprint_id`, project
 * id null), then workspace-wide (both null). `projects.blueprint_id` is read
 * here and nowhere else, so a new listing cannot forget the middle scope.
 */
export interface ProjectScope {
  projectId: string;
  /** The project's methodology; null = none, which is exactly the two-scope world. */
  blueprintId: string | null;
}

/** The scope of `projectId`; a missing project resolves to no methodology. */
export async function projectScope(prisma: PrismaService, projectId: string): Promise<ProjectScope> {
  const row = await prisma.project.findUnique({ where: { id: projectId }, select: { blueprintId: true } });
  return { projectId, blueprintId: row?.blueprintId ?? null };
}

/**
 * The Prisma filter for a table with `project_id` + `blueprint_id`: a project's
 * rows, its methodology's and workspace-wide ones. Without a project, the
 * workspace-wide listing: every row a methodology does not own.
 */
export function scopeWhere(scope: ProjectScope | null) {
  if (!scope) return { blueprintId: null };
  return {
    OR: [
      { projectId: scope.projectId },
      { projectId: null, blueprintId: null },
      ...(scope.blueprintId ? [{ projectId: null, blueprintId: scope.blueprintId }] : []),
    ],
  };
}

/**
 * Drop a row shadowed by a nearer one of the same name (case-insensitive):
 * a methodology's row under a project's, a workspace row under a methodology's.
 * Only clashes with a methodology row shadow, so a project with none lists
 * exactly what it did before (a project row and a workspace row of one name
 * both stay, as they always have).
 */
export function shadowByScope<T extends { name: string; projectId: string | null; blueprintId: string | null }>(rows: T[]): T[] {
  const names = (pick: (row: T) => boolean) => new Set(rows.filter(pick).map((row) => row.name.toLowerCase()));
  const project = names((row) => !!row.projectId);
  const owned = names((row) => !row.projectId && !!row.blueprintId);
  return rows.filter((row) => {
    const name = row.name.toLowerCase();
    if (row.projectId) return true;
    return row.blueprintId ? !project.has(name) : !owned.has(name);
  });
}
