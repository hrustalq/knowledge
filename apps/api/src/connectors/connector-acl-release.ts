import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Hand a connector's mirrored access over to people (#76, phase 6): its grants
 * become manual grants and its groups manual groups, exactly as they stand.
 *
 * Run when the connector is deleted or its mirroring is switched off. Nothing
 * opens up — a page restricted to an upstream team stays restricted to that
 * team — and nothing is orphaned: without this, a deleted connector would
 * leave groups the API refuses to edit (`group.readOnly`) and grants no sync
 * would ever rewrite again.
 *
 * A plain function rather than a `ConnectorAclService` method so
 * `ConnectorsService.remove` can call it without a provider cycle.
 */
export async function releaseMirroredAccess(prisma: PrismaService, connectorId: string): Promise<void> {
  await prisma.withTransaction(async () => {
    // A manager may already hold the same grant by hand; that row wins, and the
    // unique key (…, origin) would refuse a second manual one.
    await prisma.$executeRaw`
      DELETE FROM "access_grants" c
       USING "access_grants" m
       WHERE c."connector_id" = ${connectorId}::uuid
         AND c."origin" = 'connector'
         AND m."origin" = 'manual'
         AND m."resource_type" = c."resource_type"
         AND m."resource_id" = c."resource_id"
         AND m."subject_type" = c."subject_type"
         AND m."subject_id" = c."subject_id"`;
    await prisma.accessGrant.updateMany({
      where: { connectorId, origin: 'connector' },
      data: { origin: 'manual', connectorId: null },
    });

    const groups = await prisma.userGroup.findMany({ where: { connectorId }, select: { id: true } });
    if (groups.length > 0) {
      const ids = groups.map((g) => g.id);
      await prisma.userGroupMember.updateMany({ where: { groupId: { in: ids } }, data: { source: 'manual' } });
      await prisma.userGroup.updateMany({
        where: { id: { in: ids } },
        data: { source: 'manual', connectorId: null, externalId: null },
      });
    }
    await prisma.connectorLink.updateMany({
      where: { connectorId },
      data: { aclHash: null, aclRestricted: false },
    });
  });
}

/** Prisma's unique-violation code, for the group-name retry. */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}
