import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector } from '@prisma/client';
import type { Env } from '../config/env.js';
import { ConnectorsService } from '../connectors/connectors.service.js';
import { connectorFetch, type ConnectorContext } from '../connectors/adapters/connector.types.js';
import { figmaAllowedFiles, figmaGet } from '../connectors/adapters/figma.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { embedSnapshotKey, type EmbedSnapshotJob } from './embeds.constants.js';
import { EMBED_RETRY_MS, NOT_ALLOWLISTED, embedFileAllowed } from './embeds.service.js';

/** The slice of a Figma node this file reads. */
export interface FigmaNode {
  type?: string;
  name?: string;
  characters?: string;
  absoluteBoundingBox?: { width: number; height: number } | null;
  children?: FigmaNode[];
}

/** Text layers in reading order, deduplicated, cut to `maxBytes` of UTF-8. */
export function figmaNodeText(node: FigmaNode, maxBytes: number): string {
  const seen = new Set<string>();
  const walk = (n: FigmaNode) => {
    const text = n.type === 'TEXT' ? (n.characters ?? '').replace(/\s+/g, ' ').trim() : '';
    if (text) seen.add(text);
    n.children?.forEach(walk);
  };
  walk(node);
  let out = '';
  for (const line of seen) {
    const next = out ? `${out}\n${line}` : line;
    if (Buffer.byteLength(next) > maxBytes) break;
    out = next;
  }
  return out;
}

/** The scale that renders at `scale`, unless the long side would pass `maxPx`. Figma accepts 0.01–4. */
export function figmaRenderScale(box: { width: number; height: number } | null | undefined, scale: number, maxPx: number): number {
  const long = Math.max(box?.width ?? 0, box?.height ?? 0);
  const fit = long > 0 ? Math.min(scale, maxPx / long) : scale;
  return Math.max(0.01, Math.min(4, Math.floor(fit * 100) / 100));
}

/**
 * Renders one pinned item into storage (#470, docs/features/64). Worker only.
 * Runs per item, not per revision: the bytes are content-addressed and shared
 * by every page that pins the same node at the same version.
 *
 * A failure never throws to the queue: it is written to the item's row with a
 * retry time, and the next read of a page that shows it queues it again.
 */
@Injectable()
export class EmbedSnapshotService {
  private readonly logger = new Logger(EmbedSnapshotService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly connectors: ConnectorsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async render(job: EmbedSnapshotJob): Promise<void> {
    const where = { workspaceId_provider_fileKey_nodeId_version: { ...job, provider: 'figma' } };
    if ((await this.prisma.embedNode.findUnique({ where }))?.snapshotKey) return;
    const resolved = await this.resolveFile(job.workspaceId, job.fileKey);
    if (!resolved) return this.fail(job, NOT_ALLOWLISTED, 60 * 60_000);
    try {
      const ctx = await this.connectors.contextFor(resolved.connector, async () => undefined);
      const rendered = job.nodeId ? await this.renderNode(ctx, job) : await this.renderFile(ctx, job);
      const key = embedSnapshotKey(job);
      await this.storage.putObjectBytes(key, rendered.png, 'image/png');
      const data = { ...rendered.meta, snapshotKey: key, error: null, retryAt: null };
      await this.prisma.embedNode.upsert({ where, create: { ...job, provider: 'figma', ...data }, update: data });
    } catch (err) {
      await this.fail(job, (err as Error).message.slice(0, 300), EMBED_RETRY_MS);
    }
  }

  /**
   * The file's row, refreshed from the allowlist when it is missing or its
   * connector no longer reaches it. Listing is the only way to learn a file's
   * project; each enabled Figma connector is listed until one reaches the file.
   */
  private async resolveFile(workspaceId: string, fileKey: string): Promise<{ connector: Connector } | null> {
    const connectors = await this.prisma.connector.findMany({ where: { workspaceId, kind: 'figma', enabled: true }, orderBy: { createdAt: 'asc' } });
    const file = await this.prisma.embedFile.findUnique({ where: { workspaceId_provider_fileKey: { workspaceId, provider: 'figma', fileKey } } });
    const current = connectors.find((c) => c.id === file?.connectorId);
    if (file && current && embedFileAllowed(file, current)) return { connector: current };
    for (const connector of connectors) {
      const ctx = await this.connectors.contextFor(connector, async () => undefined);
      const files = await figmaAllowedFiles(ctx).catch((err: unknown) => {
        this.logger.warn(`Figma allowlist of connector ${connector.id} could not be listed: ${(err as Error).message}`);
        return null;
      });
      if (!files) continue;
      // The listing is the truth for this connector: rows it no longer reaches go.
      await this.prisma.$transaction([
        this.prisma.embedFile.deleteMany({ where: { connectorId: connector.id, fileKey: { notIn: files.map((f) => f.fileKey) } } }),
        ...files.map((f) =>
          this.prisma.embedFile.upsert({
            where: { workspaceId_provider_fileKey: { workspaceId, provider: 'figma', fileKey: f.fileKey } },
            create: { workspaceId, provider: 'figma', ...f, connectorId: connector.id },
            update: { name: f.name, projectId: f.projectId, teamId: f.teamId, connectorId: connector.id, checkedAt: new Date() },
          }),
        ),
      ]);
      if (files.some((f) => f.fileKey === fileKey)) return { connector };
    }
    return null;
  }

  private async renderNode(ctx: ConnectorContext, job: EmbedSnapshotJob) {
    const { nodes } = await figmaGet<{ nodes?: Record<string, { document?: FigmaNode } | null> }>(ctx, `/v1/files/${job.fileKey}/nodes`, {
      ids: job.nodeId,
      version: job.version,
    });
    const node = nodes?.[job.nodeId]?.document;
    if (!node) throw new Error(`node ${job.nodeId} not found at version ${job.version}`);
    const box = node.absoluteBoundingBox ?? null;
    const scale = figmaRenderScale(box, this.config.get('EMBED_SNAPSHOT_SCALE', { infer: true }), this.config.get('EMBED_SNAPSHOT_MAX_PX', { infer: true }));
    const { images } = await figmaGet<{ images?: Record<string, string | null> }>(ctx, `/v1/images/${job.fileKey}`, {
      ids: job.nodeId,
      version: job.version,
      format: 'png',
      scale: String(scale),
    });
    const url = images?.[job.nodeId];
    if (!url) throw new Error(`Figma did not render node ${job.nodeId}`);
    return {
      png: await this.download(ctx, url),
      meta: {
        name: node.name ?? null,
        text: figmaNodeText(node, this.config.get('EMBED_TEXT_MAX_BYTES', { infer: true })) || null,
        subtreeHash: createHash('sha256').update(JSON.stringify(node)).digest('hex'),
        width: box ? Math.round(box.width) : null,
        height: box ? Math.round(box.height) : null,
      },
    };
  }

  /** A whole-file item shows the file's thumbnail — the one snapshot Figma does not pin to a version. */
  private async renderFile(ctx: ConnectorContext, job: EmbedSnapshotJob) {
    const { file } = await figmaGet<{ file?: { name?: string; thumbnail_url?: string } }>(ctx, `/v1/files/${job.fileKey}/meta`);
    if (!file?.thumbnail_url) throw new Error(`file ${job.fileKey} has no thumbnail`);
    return {
      png: await this.download(ctx, file.thumbnail_url),
      meta: { name: file.name ?? null, text: null, subtreeHash: null, width: null, height: null },
    };
  }

  /** Figma's render URLs are presigned on its own storage: no token goes with them. */
  private async download(ctx: ConnectorContext, url: string): Promise<Uint8Array> {
    const res = await connectorFetch(url, { signal: ctx.signal }, ctx);
    return new Uint8Array(await res.arrayBuffer());
  }

  private async fail(job: EmbedSnapshotJob, error: string, retryInMs: number): Promise<void> {
    const where = { workspaceId_provider_fileKey_nodeId_version: { ...job, provider: 'figma' } };
    const data = { error, retryAt: new Date(Date.now() + retryInMs) };
    await this.prisma.embedNode.upsert({ where, create: { ...job, provider: 'figma', ...data }, update: data });
  }
}
