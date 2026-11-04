import type { ConnectorRunInfo } from '@knowledge/contracts';
import { ROLE_ORDER } from '../auth/principal.js';
import { canSee, type AccessScope } from '../permissions/access-scope.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * The items `scope` may not read (#767): a page's item follows the page. One
 * with no page yet follows the ACL staged on it, which is only applied when the
 * page is written: that text is for whoever can approve it, not every viewer.
 */
export async function hiddenRunItems(
  prisma: PrismaService,
  scope: AccessScope,
  rows: ReadonlyArray<{ id: string; documentId: string | null; acl: unknown }>,
): Promise<Set<string>> {
  if (scope.bypass) return new Set();
  const ids = [...new Set(rows.flatMap((r) => (r.documentId ? [r.documentId] : [])))];
  const pages = await prisma.document.findMany({
    where: { id: { in: ids } },
    select: { id: true, projectId: true, path: true, restrictedBy: true },
  });
  const pageOf = new Map(pages.map((p) => [p.id, p]));
  const approves = scope.role !== null && ROLE_ORDER[scope.role] >= ROLE_ORDER.editor;
  return new Set(
    rows
      .filter((r) => {
        const page = r.documentId ? pageOf.get(r.documentId) : undefined;
        return page ? !canSee(scope, page) : r.acl !== null && !approves;
      })
      .map((r) => r.id),
  );
}

/** Runs without the warnings naming an item `scope` may not read: a warning holds that item's title and error. */
export async function withVisibleWarnings<T extends ConnectorRunInfo | null>(prisma: PrismaService, scope: AccessScope, runs: T[]): Promise<T[]> {
  const named = runs.flatMap((run) => (run?.warnings ?? []).flatMap((w) => (w.externalId === null ? [] : [{ runId: run!.id, externalId: w.externalId }])));
  if (scope.bypass || named.length === 0) return runs;
  const items = await prisma.connectorRunItem.findMany({
    where: { OR: named },
    select: { id: true, runId: true, externalId: true, documentId: true, acl: true },
  });
  const hidden = await hiddenRunItems(prisma, scope, items);
  const withheld = new Set(items.filter((i) => hidden.has(i.id)).map((i) => `${i.runId}\n${i.externalId}`));
  return runs.map((run) =>
    run ? { ...run, warnings: run.warnings.filter((w) => w.externalId === null || !withheld.has(`${run.id}\n${w.externalId}`)) } : run,
  );
}
