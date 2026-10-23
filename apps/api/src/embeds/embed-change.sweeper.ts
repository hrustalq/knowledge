import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector } from '@prisma/client';
import type { Env } from '../config/env.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { figmaGet } from '../connectors/adapters/figma.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { figmaSubtreeHash, type FigmaNode } from './embed-snapshot.service.js';

/** How often the due check runs; each Figma connector is due every EMBED_CHECK_INTERVAL_HOURS. */
const TICK_MS = 5 * 60_000;
/** Nodes asked for per Figma call: `ids` rides in the query string. */
const IDS_PER_CALL = 50;

/**
 * The Figma connector's "sync" (#470, docs/features/64): did a pinned frame
 * change in Figma? There is no cron here — a fixed tick, a due check per
 * connector on its `lastSyncedAt`, and never a second run while one is in
 * flight. It reads every node the default-branch heads pin, at the file's
 * current version, and records its subtree hash in `embed_node_heads`.
 * "Changed" is derived on read; nothing flags a page and nothing opens a
 * merge request.
 */
@Injectable()
export class EmbedChangeSweeper implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmbedChangeSweeper.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.sweep(), TICK_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sweep(now = new Date()): Promise<void> {
    if (this.running) return; // a slow check must not stack on itself
    this.running = true;
    try {
      const interval = this.config.get('EMBED_CHECK_INTERVAL_HOURS', { infer: true }) * 3_600_000;
      const connectors = await this.prisma.connector.findMany({ where: { kind: 'figma', enabled: true } });
      for (const connector of connectors) {
        if (connector.lastSyncedAt && now.getTime() - connector.lastSyncedAt.getTime() < interval) continue;
        await this.check(connector).catch((err: unknown) =>
          this.logger.warn(`Figma change check for connector ${connector.id} failed: ${(err as Error).message}`),
        );
        // Stamped whatever happened: a token Figma refuses is retried next interval, not every tick.
        await this.prisma.connector.update({ where: { id: connector.id }, data: { lastSyncedAt: now } });
      }
    } finally {
      this.running = false;
    }
  }

  /** One connector: every node the workspace's current pages pin, in files this connector reaches. */
  async check(connector: Connector): Promise<number> {
    const pinned = await this.prisma.$queryRaw<Array<{ file_key: string; node_id: string }>>`
      SELECT DISTINCT re.file_key, re.node_id
        FROM revision_embeds re
        JOIN document_branches b ON b.head_revision_id = re.revision_id
        JOIN documents d ON d.id = b.document_id AND b.name = d.default_branch
        JOIN embed_files f ON f.workspace_id = re.workspace_id AND f.provider = 'figma' AND f.file_key = re.file_key
       WHERE re.workspace_id = ${connector.workspaceId}::uuid AND f.connector_id = ${connector.id}::uuid
         AND re.warning IS NULL AND re.node_id <> ''`;
    if (!pinned.length) return 0;
    const ctx = await this.connectors.contextFor(connector, async () => undefined);
    const byFile = new Map<string, string[]>();
    for (const row of pinned) byFile.set(row.file_key, [...(byFile.get(row.file_key) ?? []), row.node_id]);
    let checked = 0;
    for (const [fileKey, nodeIds] of byFile) {
      for (let i = 0; i < nodeIds.length; i += IDS_PER_CALL) {
        const ids = nodeIds.slice(i, i + IDS_PER_CALL);
        const res = await figmaGet<{ version: string; nodes?: Record<string, { document?: FigmaNode } | null> }>(ctx, `/v1/files/${fileKey}/nodes`, {
          ids: ids.join(','),
        });
        for (const nodeId of ids) {
          const node = res.nodes?.[nodeId]?.document;
          // A node deleted in Figma has no current hash; it reads as changed (its pinned hash differs from nothing).
          const currentHash = node ? figmaSubtreeHash(node) : 'deleted';
          const where = { workspaceId_provider_fileKey_nodeId: { workspaceId: connector.workspaceId, provider: 'figma', fileKey, nodeId } };
          const data = { currentVersion: res.version, currentHash, checkedAt: new Date() };
          await this.prisma.embedNodeHead.upsert({ where, create: { ...where.workspaceId_provider_fileKey_nodeId, ...data }, update: data });
          checked++;
        }
      }
    }
    return checked;
  }
}
