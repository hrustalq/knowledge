import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector } from '@prisma/client';
import type { Env } from '../../config/env.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { t } from '../../i18n/t.js';
import { ConnectorsService } from '../connectors.service.js';
import {
  blobUrl,
  downloadRepoArchive,
  repoHost,
  repoSubdir,
  resolveBranch,
  type RepoHost,
} from '../adapters/repo-archive.js';

/**
 * The connector kinds whose external system is a git repository. Both download
 * the same archive (feature 27 built on feature 19's), so both can be read.
 */
export const REPO_CONNECTOR_KINDS: ReadonlySet<string> = new Set(['codebase', 'markdown-git']);

/** One connected repository, as the tools and the per-turn prompt clause see it. */
export interface RepoSummary {
  id: string;
  name: string;
  repoUrl: string;
  /** The configured branch, or null when the connector follows the repository's default. */
  branch: string | null;
  subdir: string;
}

/** A repository's files at one point in time, scoped to the connector's `subdir`. */
export interface RepoSnapshot {
  connectorId: string;
  workspaceId: string;
  name: string;
  branch: string;
  subdir: string;
  host: RepoHost;
  /** Repo-relative path → bytes. Binaries and files over 1 MB never made it into the archive. */
  files: Map<string, Uint8Array>;
  skipped: { oversize: number; binary: number };
  bytes: number;
  loadedAt: Date;
  /**
   * The file's address on its host, optionally anchored to a line range. Closes
   * over the connector context so the credential it carries never has to be
   * handed to a caller.
   */
  blobUrl(path: string, lines?: readonly [number, number?]): string;
}

interface CacheEntry {
  promise: Promise<RepoSnapshot>;
  /** `connectors.updated_at` at load time — an edited connector reloads on its next open. */
  version: string;
  expiresAt: number;
  lastUsed: number;
  /** Known once the promise settles; 0 while in flight. */
  bytes: number;
}

/**
 * Downloaded repositories, held in memory for the code tools (docs/features/31).
 *
 * The sync pipeline caches an archive for one run and drops it: `contextFor`
 * builds a fresh `config` object per call and `downloadRepoArchive` keys its
 * WeakMap on that object. A tool call has no run. It has a chat turn, and the
 * next turn, and a background agent reading twelve files one after another —
 * so the snapshot is keyed by connector id and kept for a while.
 *
 * In-process on purpose, not MinIO or Redis. The API and the worker each keep
 * their own copy: the first tool call in either pays one archive download and
 * the rest are instant, which is the whole cost story. A shared store would put
 * a live repository's contents into a second system for the sake of saving one
 * download per process per TTL, and would need its own eviction anyway.
 *
 * Two bounds, both env: a TTL, after which the next open re-downloads, and a
 * total byte cap across every snapshot in the process, past which the least
 * recently used is dropped. The promise is cached rather than the result, the
 * `downloadRepoArchive` rule — two tool calls in one parallel batch must not
 * both download.
 */
@Injectable()
export class RepoSnapshotService {
  private readonly logger = new Logger(RepoSnapshotService.name);
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    config: ConfigService<Env, true>,
  ) {
    this.ttlMs = config.get('CODE_SNAPSHOT_TTL_MS', { infer: true });
    this.maxBytes = config.get('CODE_SNAPSHOT_MAX_BYTES', { infer: true });
  }

  /**
   * The repositories this workspace may read — what decides whether the tools
   * are offered at all, and what the prompt clause lists. No network: it is
   * called on every chat turn.
   */
  async listRepos(workspaceId: string): Promise<RepoSummary[]> {
    const rows = await this.prisma.connector.findMany({
      where: { workspaceId, enabled: true, kind: { in: [...REPO_CONNECTOR_KINDS] } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => this.summarize(row));
  }

  /**
   * The snapshot for one connector, loading it on first use.
   *
   * Eligibility is re-checked on every call rather than trusted from whoever
   * offered the tool: a turn outlives a settings change, and a connector
   * disabled mid-thread has to actually go away. A connector in another
   * workspace reads as not found — the id is the model's to guess, and a 403
   * would confirm the guess.
   */
  async open(connectorId: string, workspaceId: string): Promise<RepoSnapshot> {
    const row = await this.connectors.require(connectorId);
    if (row.workspaceId !== workspaceId) {
      throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    }
    if (!REPO_CONNECTOR_KINDS.has(row.kind)) {
      throw new BadRequestException(t('error.code.notARepository', { name: row.name }));
    }
    if (!row.enabled) {
      throw new BadRequestException(t('error.code.connectorDisabled', { name: row.name }));
    }

    const now = Date.now();
    const version = row.updatedAt.toISOString();
    const cached = this.cache.get(connectorId);
    if (cached && cached.version === version && cached.expiresAt > now) {
      cached.lastUsed = now;
      return cached.promise;
    }

    const entry: CacheEntry = {
      promise: this.load(row),
      version,
      expiresAt: now + this.ttlMs,
      lastUsed: now,
      bytes: 0,
    };
    this.cache.set(connectorId, entry);
    entry.promise.then(
      (snapshot) => {
        entry.bytes = snapshot.bytes;
        this.evict();
      },
      () => {
        // A failed download must not be served for the rest of the TTL.
        if (this.cache.get(connectorId) === entry) this.cache.delete(connectorId);
      },
    );
    return entry.promise;
  }

  /** Forget one repository — the next open downloads it again. */
  invalidate(connectorId: string): void {
    this.cache.delete(connectorId);
  }

  // --- internals ---

  private async load(row: Connector): Promise<RepoSnapshot> {
    // The context is kept alive inside the snapshot's `blobUrl` closure. It
    // carries the credential `contextFor` resolved — for a picker-configured
    // connector, a freshly minted installation token — so it is never exposed
    // as a field, only used to build addresses.
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    const [archive, branch] = await Promise.all([downloadRepoArchive(ctx), resolveBranch(ctx)]);
    const subdir = repoSubdir(ctx);
    const host = repoHost(ctx);

    const files = new Map<string, Uint8Array>();
    let bytes = 0;
    for (const [path, content] of archive.files) {
      if (subdir && path !== subdir && !path.startsWith(`${subdir}/`)) continue;
      files.set(path, content);
      bytes += content.byteLength;
    }

    this.logger.log(
      `snapshot ${row.id} (${row.name}): ${files.size} files, ${bytes} bytes at ${host.owner}/${host.repo}@${branch}`,
    );

    return {
      connectorId: row.id,
      workspaceId: row.workspaceId,
      name: row.name,
      branch,
      subdir,
      host,
      files,
      skipped: archive.skipped,
      bytes,
      loadedAt: new Date(),
      blobUrl: (path, lines) => blobUrl(ctx, path, branch) + lineAnchor(host, lines),
    };
  }

  /** Drop least recently used snapshots until the process is under the byte cap. */
  private evict(): void {
    let total = 0;
    for (const entry of this.cache.values()) total += entry.bytes;
    if (total <= this.maxBytes) return;

    const byAge = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [id, entry] of byAge) {
      if (total <= this.maxBytes) break;
      if (entry.bytes === 0) continue; // still downloading — its size is not known yet
      this.cache.delete(id);
      total -= entry.bytes;
      this.logger.log(`snapshot ${id} evicted (${entry.bytes} bytes) — process over CODE_SNAPSHOT_MAX_BYTES`);
    }
  }

  private summarize(row: Connector): RepoSummary {
    const config = (row.config ?? {}) as Record<string, unknown>;
    const branch = typeof config.branch === 'string' ? config.branch.trim() : '';
    const subdir = typeof config.subdir === 'string' ? config.subdir.replace(/^\/+|\/+$/g, '') : '';
    return {
      id: row.id,
      name: row.name,
      repoUrl: typeof config.repoUrl === 'string' ? config.repoUrl : '',
      branch: branch || null,
      subdir,
    };
  }
}

/**
 * GitHub anchors a range as `#L10-L20`, GitLab as `#L10-20`; any other host gets
 * GitHub's, which is also what most self-hosted forges accept.
 */
export function lineAnchor(host: RepoHost, lines?: readonly [number, number?]): string {
  if (!lines) return '';
  const [start, end] = lines;
  if (!Number.isFinite(start) || start < 1) return '';
  if (end === undefined || end <= start) return `#L${start}`;
  return host.kind === 'gitlab' ? `#L${start}-${end}` : `#L${start}-L${end}`;
}
