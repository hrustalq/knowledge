import type { PrismaClient } from '@prisma/client';

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
