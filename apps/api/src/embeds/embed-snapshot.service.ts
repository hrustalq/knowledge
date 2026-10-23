import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { connectorFetch, type ConnectorContext } from '../connectors/adapters/connector.types.js';
import { figmaGet } from '../connectors/adapters/figma.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { embedSnapshotKey, type EmbedSnapshotJob } from './embeds.constants.js';
import { EMBED_RETRY_MS, NOT_ALLOWLISTED } from './embeds.service.js';
import { FigmaFilesService } from './figma-files.service.js';
import { IngestionProducer } from '../ingestion/ingestion.producer.js';

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly files: FigmaFilesService,
    private readonly ingestion: IngestionProducer,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async render(job: EmbedSnapshotJob): Promise<void> {
    const where = { workspaceId_provider_fileKey_nodeId_version: { ...job, provider: 'figma' } };
    if ((await this.prisma.embedNode.findUnique({ where }))?.snapshotKey) return;
    const ctx = await this.files.contextFor(job.workspaceId, job.fileKey);
    if (!ctx) return this.fail(job, NOT_ALLOWLISTED, 60 * 60_000);
    try {
      const rendered = job.nodeId ? await this.renderNode(ctx, job) : await this.renderFile(ctx, job);
      const key = embedSnapshotKey(job);
      await this.storage.putObjectBytes(key, rendered.png, 'image/png');
      const data = { ...rendered.meta, snapshotKey: key, error: null, retryAt: null };
      await this.prisma.embedNode.upsert({ where, create: { ...job, provider: 'figma', ...data }, update: data });
      // The frame's text joins search only through a reindex of the pages
      // that pin it: indexing reads the cache and never waits on a render.
      if (rendered.meta.text || rendered.meta.name) await this.reindexPinning(job);
    } catch (err) {
      await this.fail(job, (err as Error).message.slice(0, 300), EMBED_RETRY_MS);
    }
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

  /**
   * Reindex the branch heads that pin this item, through the outbox exactly as
   * a manual reindex does. Runs once per item: a rendered item returns early
   * from `render`, so a reindex never loops back into another one.
   */
  private async reindexPinning(job: EmbedSnapshotJob): Promise<void> {
    const heads = await this.prisma.$queryRaw<Array<{ id: string; document_id: string; s3_key: string; title: string }>>`
      SELECT DISTINCT r.id, r.document_id, r.s3_key, d.title
        FROM revision_embeds re
        JOIN document_branches b ON b.head_revision_id = re.revision_id
        JOIN document_revisions r ON r.id = re.revision_id
        JOIN documents d ON d.id = r.document_id
       WHERE re.workspace_id = ${job.workspaceId}::uuid AND re.file_key = ${job.fileKey}
         AND re.node_id = ${job.nodeId} AND re.version = ${job.version}
         AND r.status IN ('indexed', 'failed')`;
    for (const rev of heads) {
      const row = await this.prisma.ingestionJob.create({
        data: {
          workspaceId: job.workspaceId,
          revisionId: rev.id,
          type: 'reindex',
          status: 'queued',
          payload: { documentId: rev.document_id, revisionId: rev.id, s3Key: rev.s3_key, title: rev.title, reason: 'embed rendered' },
        },
      });
      await this.ingestion.enqueue(row.id).catch(() => undefined); // the outbox sweeper re-enqueues
    }
  }

  private async fail(job: EmbedSnapshotJob, error: string, retryInMs: number): Promise<void> {
    const where = { workspaceId_provider_fileKey_nodeId_version: { ...job, provider: 'figma' } };
    const data = { error, retryAt: new Date(Date.now() + retryInMs) };
    await this.prisma.embedNode.upsert({ where, create: { ...job, provider: 'figma', ...data }, update: data });
  }
}
