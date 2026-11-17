import { blueprintText, isBuiltInBlueprintKey, levelOf, type Blueprint, type BlueprintLevel, type Locale, type PageLevel } from '@knowledge/contracts';
import type { PrismaService } from '../prisma/prisma.service.js';
import { BUILT_IN_BLUEPRINTS } from '../blueprints/built-in/index.js';

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

/**
 * Each project's methodology levels (#1126), in order; a project without a
 * methodology maps to none. One read for any number of projects: what a
 * search or a page read resolves once per request. A built-in override with
 * no version of its own serves the code's levels, as `BlueprintsService` does.
 */
export async function projectLevels(prisma: PrismaService, projectIds: readonly string[]): Promise<Map<string, BlueprintLevel[]>> {
  const out = new Map<string, BlueprintLevel[]>();
  const ids = [...new Set(projectIds)];
  if (!ids.length) return out;
  const projects = await prisma.project.findMany({ where: { id: { in: ids }, blueprintId: { not: null } }, select: { id: true, blueprintId: true } });
  if (!projects.length) return out;
  const rows = await prisma.projectBlueprint.findMany({
    where: { id: { in: [...new Set(projects.map((p) => p.blueprintId!))] } },
    select: { id: true, builtInKey: true, versions: { orderBy: { version: 'desc' }, take: 1, select: { blueprint: true } } },
  });
  const levels = new Map(
    rows.map((r) => {
      const own = r.versions[0]?.blueprint as unknown as Blueprint | undefined;
      const builtIn = r.builtInKey && isBuiltInBlueprintKey(r.builtInKey) ? BUILT_IN_BLUEPRINTS[r.builtInKey] : undefined;
      return [r.id, (own ?? builtIn)?.levels ?? []];
    }),
  );
  for (const p of projects) {
    const found = levels.get(p.blueprintId!);
    if (found?.length) out.set(p.id, found);
  }
  return out;
}

/** One level of `projectId`'s methodology by key, with the methodology's id (#1128); null when it declares none such. */
export async function projectLevel(
  prisma: PrismaService,
  projectId: string,
  key: string,
): Promise<{ level: BlueprintLevel; blueprintId: string } | null> {
  const [{ blueprintId }, levels] = await Promise.all([projectScope(prisma, projectId), projectLevels(prisma, [projectId])]);
  const level = levels.get(projectId)?.find((l) => l.key === key);
  return level && blueprintId ? { level, blueprintId } : null;
}

/** A page's level as responses carry it, or undefined. */
export function pageLevel(templateRef: string | null | undefined, levels: readonly BlueprintLevel[] | undefined, locale: Locale): PageLevel | undefined {
  const level = levelOf(templateRef, levels);
  return level ? { key: level.key, name: blueprintText(level.name, locale) } : undefined;
}
