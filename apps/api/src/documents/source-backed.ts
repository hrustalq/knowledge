import { Prisma, type PrismaClient } from '@prisma/client';
import type { SourceSyncHealth } from '@knowledge/contracts';

/**
 * The `web` connector whose source-backed page this is (#674), or null.
 *
 * The read-only predicate: `DocumentsService.createDraftRevision` refuses any
 * writer but this connector, and the detail route reports it so the app hides
 * Edit. A leaf so the connectors code can ask the same question without
 * importing a service.
 */
export async function sourceConnectorOf(db: Pick<PrismaClient, 'connectorLink'>, documentId: string): Promise<string | null> {
  const link = await db.connectorLink.findFirst({
    where: { documentId, connector: { kind: 'web' } },
    select: { connectorId: true },
  });
  return link?.connectorId ?? null;
}

/**
 * The sync health (#674, phase 5) of each of `documentIds` that is
 * source-backed, with the host its badge names; a page missing from the map
 * is not. What `verificationStateFor` reads as `source`.
 */
export async function sourceSyncOf(
  db: Pick<PrismaClient, 'connectorLink'>,
  documentIds: readonly string[],
): Promise<Map<string, SourceSyncHealth & { host: string }>> {
  if (documentIds.length === 0) return new Map();
  const links = await db.connectorLink.findMany({
    where: { documentId: { in: [...documentIds] }, connector: { kind: 'web' } },
    select: {
      documentId: true,
      externalId: true,
      externalUrl: true,
      pausedAt: true,
      heldAt: true,
      failures: true,
      lastPulledAt: true,
      connector: { select: { syncIntervalMinutes: true } },
    },
  });
  return new Map(
    links.map((l) => [
      l.documentId,
      {
        pausedAt: l.pausedAt,
        heldAt: l.heldAt,
        failures: l.failures,
        lastPulledAt: l.lastPulledAt,
        intervalMinutes: l.connector.syncIntervalMinutes,
        host: hostOf(l.externalUrl ?? l.externalId),
      },
    ]),
  );
}

/**
 * `sourceSyncHealthy` and its use in `verificationStateFor`, in SQL: a CASE
 * branch for a page whose `alias` row is source-backed, placed where the TS
 * predicate checks `doc.source`. Change the three together.
 */
export function sourceStateSql(alias: string, now: Date): Prisma.Sql {
  const d = Prisma.raw(alias);
  return Prisma.sql`WHEN EXISTS (
      SELECT 1 FROM connector_links cl JOIN connectors c ON c.id = cl.connector_id AND c.kind = 'web' WHERE cl.document_id = ${d}.id
    ) THEN CASE WHEN EXISTS (
      SELECT 1 FROM connector_links cl JOIN connectors c ON c.id = cl.connector_id AND c.kind = 'web'
       WHERE cl.document_id = ${d}.id AND cl.paused_at IS NULL AND cl.held_at IS NULL AND cl.failures = 0
         AND (c.sync_interval_minutes IS NULL
              OR cl.last_pulled_at >= ${now}::timestamptz - make_interval(mins => 2 * c.sync_interval_minutes))
    ) THEN 'verified' ELSE 'expired' END`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
