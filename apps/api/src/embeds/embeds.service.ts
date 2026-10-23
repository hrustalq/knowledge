import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import type { Connector, EmbedFile, EmbedNode } from '@prisma/client';
import {
  FIGMA_ALLOWLIST_CONFIG_KEY,
  parseEmbedUrl,
  parseFigmaAllowlist,
  type EmbedItemState,
  type EmbedItemStatus,
  type EmbedWarning,
} from '@knowledge/contracts';
import { embedGroupsOf } from '@knowledge/editor-schema/markdown';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { EMBEDS_QUEUE, embedJobId, type EmbedSnapshotJob } from './embeds.constants.js';

/**
 * The one read-time access rule for an embedded file (#470, docs/features/64):
 * its connector is enabled and still lists the file's project or team. Checked
 * on every snapshot read, so removing an allowlist entry or disabling the
 * connector hides the snapshot everywhere, old revisions included, and adding
 * it back restores it — the bytes never left storage.
 */
export function embedFileAllowed(file: Pick<EmbedFile, 'projectId' | 'teamId'>, connector: Pick<Connector, 'enabled' | 'kind' | 'config'> | null | undefined): boolean {
  if (!connector?.enabled || connector.kind !== 'figma') return false;
  const allowlist = parseFigmaAllowlist(String((connector.config as Record<string, unknown>)?.[FIGMA_ALLOWLIST_CONFIG_KEY] ?? ''));
  return allowlist.projects.includes(file.projectId) || (!!file.teamId && allowlist.teams.includes(file.teamId));
}

/** A failed render waits this long before a read queues it again. */
export const EMBED_RETRY_MS = 15 * 60_000;

/** A file the allowlist did not reach: looked up again after this. */
export const NOT_ALLOWLISTED = 'not-allowlisted';

type Key = Pick<EmbedSnapshotJob, 'fileKey' | 'nodeId' | 'version'>;

/**
 * The core of embeds: what a revision references, and what a reader may see
 * of it. Controller-free, so the ingestion worker records through it and the
 * API serves through it.
 */
@Injectable()
export class EmbedsService {
  private readonly logger = new Logger(EmbedsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly config: ConfigService<Env, true>,
    @InjectQueue(EMBEDS_QUEUE) private readonly queue: Queue<EmbedSnapshotJob>,
  ) {}

  /**
   * Record the revision's items (idempotent: a re-index rewrites them) and
   * queue a render for each pinned one. Nothing here calls Figma, so indexing
   * never waits on it or fails because of it.
   */
  async recordRevision(input: { workspaceId: string; documentId: string; revisionId: string; markdown: string }): Promise<void> {
    const max = this.config.get('EMBED_MAX_ITEMS', { infer: true });
    const rows = embedGroupsOf(input.markdown).flatMap((group, groupIndex) =>
      group.items.map((item, position) => {
        const ref = parseEmbedUrl(item.url);
        const warning: EmbedWarning | null = !ref ? 'unknown-provider' : position >= max ? 'over-limit' : !item.version ? 'unpinned' : null;
        return {
          workspaceId: input.workspaceId,
          documentId: input.documentId,
          revisionId: input.revisionId,
          groupIndex,
          position,
          url: item.url,
          provider: ref?.provider ?? null,
          fileKey: ref?.fileKey ?? null,
          nodeId: ref ? (ref.nodeId ?? '') : null,
          version: item.version,
          caption: item.caption,
          warning,
        };
      }),
    );
    await this.prisma.$transaction([
      this.prisma.revisionEmbed.deleteMany({ where: { revisionId: input.revisionId } }),
      ...(rows.length ? [this.prisma.revisionEmbed.createMany({ data: rows })] : []),
    ]);
    const pinned = rows.filter((r) => !r.warning) as Array<(typeof rows)[number] & Key>;
    await this.enqueue(input.workspaceId, pinned).catch((err: unknown) =>
      // Non-fatal: the next read of the page queues it again.
      this.logger.warn(`Embed renders could not be queued for ${input.revisionId}: ${(err as Error).message}`),
    );
  }

  /** Every pinned item any revision of the document references, with what a reader may see of it. */
  async documentStatus(documentId: string): Promise<EmbedItemStatus[]> {
    const refs = await this.prisma.revisionEmbed.findMany({
      where: { documentId, warning: null, fileKey: { not: null } },
      distinct: ['fileKey', 'nodeId', 'version'],
      select: { workspaceId: true, fileKey: true, nodeId: true, version: true },
    });
    if (!refs.length) return [];
    const workspaceId = refs[0]!.workspaceId;
    const keys = refs as Array<{ workspaceId: string } & Key>;
    const access = await this.accessFor(workspaceId, [...new Set(keys.map((k) => k.fileKey))]);
    const nodes = await this.nodesFor(workspaceId, keys);
    const now = Date.now();
    const queue: Key[] = [];
    const out = keys.map((key): EmbedItemStatus => {
      const node = nodes.get(nodeKey(key));
      const state = stateOf(access(key.fileKey), node, now);
      if (state === 'rendering' && !node?.snapshotKey) queue.push(key);
      return {
        fileKey: key.fileKey,
        nodeId: key.nodeId,
        version: key.version,
        state,
        name: node?.name ?? null,
        width: node?.width ?? null,
        height: node?.height ?? null,
      };
    });
    await this.enqueue(workspaceId, queue).catch(() => undefined);
    return out;
  }

  /**
   * A presigned URL for one snapshot, or a 404 — when no revision of this
   * document references the item, when the allowlist does not pass right now,
   * or when there are no bytes yet. A member of the workspace cannot reach a
   * snapshot by guessing its key.
   */
  async snapshotUrl(documentId: string, key: Key): Promise<string> {
    const ref = await this.prisma.revisionEmbed.findFirst({
      where: { documentId, fileKey: key.fileKey, nodeId: key.nodeId, version: key.version, warning: null },
      select: { workspaceId: true },
    });
    const node = ref
      ? await this.prisma.embedNode.findUnique({
          where: { workspaceId_provider_fileKey_nodeId_version: { workspaceId: ref.workspaceId, provider: 'figma', ...key } },
        })
      : null;
    if (!ref || !node?.snapshotKey) throw new NotFoundException();
    const access = await this.accessFor(ref.workspaceId, [key.fileKey]);
    if (access(key.fileKey) !== 'allowed') throw new NotFoundException();
    return this.storage.presignGet(node.snapshotKey, {
      filename: `${key.fileKey}-${key.nodeId.replace(/[:;]/g, '-') || 'file'}-${key.version}.png`,
      contentType: 'image/png',
      disposition: 'inline',
    });
  }

  /** Queue a render per item; the job id is the item, so a repeat collapses into the one job. */
  async enqueue(workspaceId: string, keys: Key[]): Promise<void> {
    const seen = new Set<string>();
    for (const key of keys) {
      const job = { workspaceId, fileKey: key.fileKey, nodeId: key.nodeId, version: key.version };
      const id = embedJobId(job);
      if (seen.has(id)) continue;
      seen.add(id);
      await this.queue.add('snapshot', job, { jobId: id, attempts: 1, removeOnComplete: true, removeOnFail: true });
    }
  }

  /**
   * Per file: `allowed`, `blocked` (known, but its connector no longer reaches
   * it) or `unknown` (never resolved — the render job lists the allowlist).
   * With no enabled Figma connector at all, everything is `blocked`.
   */
  private async accessFor(workspaceId: string, fileKeys: string[]): Promise<(fileKey: string) => 'allowed' | 'blocked' | 'unknown'> {
    const [files, connectors] = await Promise.all([
      this.prisma.embedFile.findMany({ where: { workspaceId, provider: 'figma', fileKey: { in: fileKeys } } }),
      this.prisma.connector.findMany({ where: { workspaceId, kind: 'figma' }, select: { id: true, enabled: true, kind: true, config: true } }),
    ]);
    const byId = new Map(connectors.map((c) => [c.id, c]));
    const anyEnabled = connectors.some((c) => c.enabled);
    const byKey = new Map(files.map((f) => [f.fileKey, f]));
    return (fileKey) => {
      const file = byKey.get(fileKey);
      if (file) return embedFileAllowed(file, byId.get(file.connectorId)) ? 'allowed' : 'blocked';
      return anyEnabled ? 'unknown' : 'blocked';
    };
  }

  private async nodesFor(workspaceId: string, keys: Key[]): Promise<Map<string, EmbedNode>> {
    const rows = await this.prisma.embedNode.findMany({
      where: { workspaceId, provider: 'figma', OR: keys.map((k) => ({ fileKey: k.fileKey, nodeId: k.nodeId, version: k.version })) },
    });
    return new Map(rows.map((r) => [nodeKey(r), r]));
  }
}

function nodeKey(key: Key): string {
  return `${key.fileKey}/${key.nodeId}/${key.version}`;
}

/** One item's state from its access and its cache row — the one place the four states are decided. */
export function stateOf(access: 'allowed' | 'blocked' | 'unknown', node: Pick<EmbedNode, 'snapshotKey' | 'error' | 'retryAt'> | undefined, now: number): EmbedItemState {
  if (access === 'blocked') return 'unavailable';
  if (node?.snapshotKey) return access === 'allowed' ? 'ready' : 'rendering';
  if (node?.error && node.retryAt && node.retryAt.getTime() > now) return node.error === NOT_ALLOWLISTED ? 'unavailable' : 'failed';
  return 'rendering';
}
