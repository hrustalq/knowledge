import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConnectorKind, ConnectorLinkSummary, DocumentConnectorLink } from '@knowledge/contracts';
import { connectorKindInfo } from '@knowledge/contracts';
import type { ConnectorLink } from '@prisma/client';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Reads over `connector_links` — the identity map between external items and
 * pages. Kept apart from ConnectorsService because the document side asks a
 * different question ("what is this page attached to?") than the settings side
 * ("what has this connector claimed?").
 */
@Injectable()
export class ConnectorLinksService {
  constructor(private readonly prisma: PrismaService) {}

  async listForConnector(connectorId: string): Promise<ConnectorLinkSummary[]> {
    const rows = await this.prisma.connectorLink.findMany({
      where: { connectorId },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const titles = await this.titlesFor(rows.map((r) => r.documentId));
    return rows.map((row) => toLinkSummary(row, titles.get(row.documentId) ?? null));
  }

  async listForDocument(documentId: string): Promise<DocumentConnectorLink[]> {
    const rows = await this.prisma.connectorLink.findMany({
      where: { documentId },
      include: { connector: true },
    });
    const titles = await this.titlesFor([documentId]);
    return rows.map((row) => ({
      connectorId: row.connectorId,
      connectorName: row.connector.name,
      kind: row.connector.kind as ConnectorKind,
      canPush:
        (connectorKindInfo(row.connector.kind)?.capabilities.push ?? false) &&
        row.connector.direction !== 'pull' &&
        row.connector.enabled,
      link: toLinkSummary(row, titles.get(documentId) ?? null),
    }));
  }

  /** The link a push of this page would go through, if any. */
  async pushTargetFor(documentId: string): Promise<ConnectorLink & { connector: { id: string } }> {
    const row = await this.prisma.connectorLink.findFirst({
      where: { documentId, connector: { enabled: true, direction: { in: ['push', 'both'] } } },
      include: { connector: true },
    });
    if (!row) throw new NotFoundException(t('error.connector.notLinked'));
    return row;
  }

  async remove(linkId: string): Promise<void> {
    const row = await this.prisma.connectorLink.findUnique({ where: { id: linkId } });
    if (!row) throw new NotFoundException(t('error.connector.linkNotFound', { id: linkId }));
    // The page stays: unlinking says "stop syncing this", not "delete it".
    await this.prisma.connectorLink.delete({ where: { id: linkId } });
  }

  private async titlesFor(documentIds: string[]): Promise<Map<string, string>> {
    if (documentIds.length === 0) return new Map();
    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...new Set(documentIds)] } },
      select: { id: true, title: true },
    });
    return new Map(docs.map((d) => [d.id, d.title]));
  }
}

export function toLinkSummary(row: ConnectorLink, documentTitle: string | null): ConnectorLinkSummary {
  return {
    id: row.id,
    connectorId: row.connectorId,
    documentId: row.documentId,
    documentTitle,
    externalId: row.externalId,
    externalUrl: row.externalUrl,
    externalTitle: row.externalTitle,
    externalVersion: row.externalVersion,
    lastPulledAt: row.lastPulledAt?.toISOString() ?? null,
    lastPushedAt: row.lastPushedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}
