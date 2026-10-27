import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { t } from '../../i18n/t.js';
import { systemScope } from '../../permissions/access-scope.js';
import { ConnectorsService } from '../connectors.service.js';
import { importOutline, collectImportEdges, SFC_FILE } from '../adapters/import-edges.js';
import { createFileResolver } from '../adapters/import-resolver.js';
import { fetchPullRequestFiles, type PullRequestFile, type PullRequestFiles } from '../adapters/pull-request.js';
import { readRepoFile } from '../adapters/repo-history.js';
import { TreeSitterService } from '../adapters/tree-sitter.service.js';
import { REPO_CONNECTOR_KINDS, RepoSnapshotService } from './repo-snapshot.service.js';

/** Changed files re-read at the head for one check — one request each. */
export const MAX_OVERLAY_FILES = 60;
/** Requests in flight at once while reading them. */
const OVERLAY_CONCURRENCY = 6;
/** A changed config file changes how every import resolves, so it is read too. */
const RESOLVER_CONFIG = /(?:^|\/)(?:package\.json|tsconfig[^/]*\.json)$/;

/** What a pull request's head imports, laid over its base (#236). */
export interface HeadImports {
  /** importer → imported rows for the changed files, as the head has them. */
  rows: Array<{ importerPath: string; importedPath: string; names: string[] }>;
  /** Importers whose default-branch rows `rows` replace: re-read, removed, or moved away from. */
  replaced: string[];
  /** The default branch's files — what tells a declared directory from a file. */
  baseFiles: ReadonlySet<string>;
  /** Changed source files that could not be read at the head, or were past the cap. */
  unread: number;
}

/**
 * A connected repository's pull requests, reached through the connector's own
 * credential (docs/features/35).
 *
 * Beside `RepoSnapshotService` because it is the same kind of access — reading
 * a repository the workspace has connected. Read-only on purpose: this module
 * loads in the worker, and the comment on the pull request is an outward write
 * the API makes (`DriftPublishSweeper`), never an unattended run. The
 * credential never leaves here; callers pass a connector id.
 *
 * Eligibility is re-read on every call, the snapshot rule: a run can wait in
 * the queue long enough for somebody to disable the connector it names.
 */
@Injectable()
export class PullRequestService {
  private readonly logger = new Logger(PullRequestService.name);

  constructor(
    private readonly connectors: ConnectorsService,
    private readonly snapshots: RepoSnapshotService,
    private readonly treeSitter: TreeSitterService,
  ) {}

  async files(connectorId: string, workspaceId: string, number: number): Promise<PullRequestFiles> {
    const ctx = await this.context(connectorId, workspaceId);
    return fetchPullRequestFiles(ctx, number);
  }

  /**
   * The imports of the files a pull request changed, read at its head and
   * resolved against the default branch with those files swapped in (#236).
   *
   * Only the changed files are read from the host — the rest of the repository
   * is the cached snapshot the code tools already hold — so an importer the
   * pull request adds counts, at a request per changed file. A file that will
   * not read is counted, not fatal: its default-branch rows stand in for it,
   * which is why `replaced` names only what was actually replaced.
   */
  async headImports(connectorId: string, workspaceId: string, ref: string, changed: PullRequestFile[]): Promise<HeadImports> {
    const [ctx, snapshot] = await Promise.all([
      this.context(connectorId, workspaceId),
      // Overlay data for the drift check, never shown to a reader as code.
      this.snapshots.open(connectorId, systemScope(workspaceId)),
    ]);
    const files = new Map(snapshot.files);
    for (const f of changed) {
      if (f.previousPath) files.delete(f.previousPath);
      if (f.status === 'removed') files.delete(f.path);
    }

    const wanted = changed.filter(
      (f) =>
        f.status !== 'removed' &&
        (SFC_FILE.test(f.path) || this.treeSitter.languageForPath(f.path) !== null || RESOLVER_CONFIG.test(f.path)),
    );
    const reading = wanted.slice(0, MAX_OVERLAY_FILES);
    let unread = wanted.length - reading.length;
    const read = new Set<string>();
    for (let i = 0; i < reading.length; i += OVERLAY_CONCURRENCY) {
      await Promise.all(
        reading.slice(i, i + OVERLAY_CONCURRENCY).map(async (f) => {
          try {
            const text = await readRepoFile(ctx, f.path, ref);
            if (text === null) throw new Error('not found at the head');
            files.set(f.path, Buffer.from(text, 'utf8'));
            read.add(f.path);
          } catch (error) {
            unread += 1;
            this.logger.warn(`could not read ${f.path} at ${ref.slice(0, 7)}: ${(error as Error).message}`);
          }
        }),
      );
    }

    const importers = [...read].filter((p) => !RESOLVER_CONFIG.test(p));
    const { edges } = await collectImportEdges(importers, createFileResolver(files), (path) =>
      importOutline(this.treeSitter, path, files),
    );
    const replaced = changed.flatMap((f) => [
      ...(f.previousPath ? [f.previousPath] : []),
      ...(f.status === 'removed' || read.has(f.path) ? [f.path] : []),
    ]);
    return {
      rows: edges.map((e) => ({ importerPath: e.importer, importedPath: e.imported, names: e.names })),
      replaced,
      baseFiles: new Set(snapshot.files.keys()),
      unread,
    };
  }

  private async context(connectorId: string, workspaceId: string) {
    const row = await this.connectors.require(connectorId);
    if (row.workspaceId !== workspaceId) {
      throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    }
    if (!REPO_CONNECTOR_KINDS.has(row.kind)) {
      throw new BadRequestException(t('error.code.notARepository', { name: row.name }));
    }
    if (!row.enabled) throw new BadRequestException(t('error.code.connectorDisabled', { name: row.name }));
    return this.connectors.contextFor(row, async () => undefined);
  }
}
