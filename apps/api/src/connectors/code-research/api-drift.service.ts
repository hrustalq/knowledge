import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Connector } from '@prisma/client';
import { apiSpecSlug, type ApiDriftSpec, type ApiSpecDiffSummary, type Locale } from '@knowledge/contracts';
import { compareSpecs, introducedMismatches, MAX_DRIFT_MISMATCHES, type RouteInventory, type SpecUnderCheck } from '../../agents/api-drift.js';
import { diffApiSpecs } from '../../api-specs/api-diff.js';
import { parseApiSpec, type ParsedApiSpec } from '../../api-specs/api-spec.parser.js';
import type { Env } from '../../config/env.js';
import { t } from '../../i18n/t.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ConnectorsService } from '../connectors.service.js';
import type { PullRequestFile } from '../adapters/pull-request.js';
import { downloadRepoArchive, repoSubdir } from '../adapters/repo-archive.js';
import { readRepoFile } from '../adapters/repo-history.js';
import { mayBeSpecSource, repoSpecFiles, specPathOfLink } from '../adapters/repo-specs.js';
import { fileRoutes, isRouteLanguage, mayDeclareRoutes, type FileRoutes } from '../adapters/route-extract.js';
import { TreeSitterService } from '../adapters/tree-sitter.service.js';
import { MAX_OVERLAY_FILES } from './pull-request.service.js';
import { REPO_CONNECTOR_KINDS, RepoSnapshotService } from './repo-snapshot.service.js';

/** Requests in flight at once while reading a pull request's head. */
const READ_CONCURRENCY = 6;

/** A linked spec document, as the comparison needs it. */
interface LinkedSpec {
  documentId: string;
  title: string;
  specPath: string;
  slug: string | null;
}

interface SpecState {
  parsed: ParsedApiSpec;
  version: string;
}

export interface ApiDriftResult {
  specs: ApiDriftSpec[];
  warnings: string[];
}

/** Per archive: every file's routes, read once — the sentinel and the on-demand check both ask. */
const inventories = new WeakMap<Map<string, Uint8Array>, Promise<Map<string, FileRoutes>>>();

/**
 * The spec ↔ code drift check over a connected repository (#78, phase 8).
 *
 * Reads, never writes: it loads in the worker beside the code tools, and its
 * answer becomes findings and a pull request comment through the sentinel's
 * usual path. The comparison rules are `agents/api-drift.ts`; the routes are
 * `route-extract.ts`; this joins them to the repository.
 *
 * The whole repository is read, not the connector's `subdir`: specs are
 * matched from the repository root (phase 7), and the code a docs connector
 * documents sits beside its `docs/`, not under it.
 *
 * On a pull request only the changed files are read at the head, over the
 * default branch — the `headImports` rule — and only what the change
 * introduces is reported. A change that touches neither a spec nor a file
 * declaring a route ties no spec, and returns null.
 */
@Injectable()
export class ApiDriftService {
  private readonly logger = new Logger(ApiDriftService.name);
  private readonly limits: { maxBytes: number; maxOperations: number };

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsService,
    private readonly snapshots: RepoSnapshotService,
    private readonly treeSitter: TreeSitterService,
    config: ConfigService<Env, true>,
  ) {
    this.limits = {
      maxBytes: config.get('API_SPEC_MAX_BYTES', { infer: true }),
      maxOperations: config.get('API_SPEC_MAX_OPERATIONS', { infer: true }),
    };
  }

  /** The spec documents a connector syncs; empty for a connector that syncs none. */
  async linkedSpecs(connectorId: string, kind: string): Promise<LinkedSpec[]> {
    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId },
      select: { externalId: true, documentId: true },
    });
    const byDocument = new Map<string, string>();
    for (const link of links) {
      const path = specPathOfLink(kind, link.externalId);
      if (path) byDocument.set(link.documentId, path);
    }
    if (byDocument.size === 0) return [];
    // OpenAPI only: routes are HTTP, and an AsyncAPI channel has no route to compare.
    const docs = await this.prisma.document.findMany({
      where: { id: { in: [...byDocument.keys()] }, kind: 'openapi', archivedAt: null },
      select: { id: true, title: true, specSlug: true },
      orderBy: { createdAt: 'asc' },
    });
    return docs.map((d) => ({ documentId: d.id, title: d.title, specPath: byDocument.get(d.id)!, slug: d.specSlug }));
  }

  /** One spec against the default branch as it stands — the on-demand check. */
  async forBranch(connectorId: string, workspaceId: string, documentId: string, locale: Locale): Promise<ApiDriftResult> {
    const row = await this.eligible(connectorId, workspaceId);
    const linked = await this.linkedSpecs(row.id, row.kind);
    if (!linked.some((s) => s.documentId === documentId)) {
      throw new BadRequestException(t('error.apiSpec.driftNotLinked', { id: documentId }));
    }
    const warnings: string[] = [];
    const files = await this.archive(row);
    const specs = await this.specStates(files, row, linked, locale, warnings);
    const inventory = inventoryOf(await this.routes(files));
    const checked = linked.filter((s) => specs.has(s.documentId));
    const mismatches = compareSpecs(checked.map((s) => underCheck(s, specs.get(s.documentId)!)), inventory, inventory.routes.length > 0);

    const at = checked.findIndex((s) => s.documentId === documentId);
    if (at < 0) return { specs: [], warnings };
    return { specs: [report(checked[at], inventory, mismatches[at])], warnings };
  }

  /**
   * What a pull request does to the agreement between its repository's specs
   * and routes, or null when it touches neither. `changed` is every file of
   * the change, not scoped to `subdir`.
   */
  async forPullRequest(
    connectorId: string,
    workspaceId: string,
    headSha: string,
    changed: readonly PullRequestFile[],
    locale: Locale,
  ): Promise<ApiDriftResult | null> {
    const row = await this.eligible(connectorId, workspaceId);
    const linked = await this.linkedSpecs(row.id, row.kind);
    if (linked.length === 0 || changed.length === 0) return null;

    const warnings: string[] = [];
    const base = await this.archive(row);
    const baseRoutes = await this.routes(base);

    const touchesSpecs = changed.some((f) => mayBeSpecSource(f.path) || (!!f.previousPath && mayBeSpecSource(f.previousPath)));
    const wanted = changed.filter(
      (f) => f.status !== 'removed' && (mayBeSpecSource(f.path) || isRouteLanguage(this.treeSitter.languageForPath(f.path))),
    );

    // The head: the default branch with the changed files swapped in.
    const head = new Map(base);
    const headRoutes = new Map(baseRoutes);
    for (const f of changed) {
      for (const path of [f.previousPath, f.status === 'removed' ? f.path : null]) {
        if (!path) continue;
        head.delete(path);
        headRoutes.delete(path);
      }
    }
    const reading = wanted.slice(0, MAX_OVERLAY_FILES);
    if (wanted.length > reading.length) warnings.push(t('agent.drift.api.headPartial', { files: wanted.length - reading.length }));
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    for (let i = 0; i < reading.length; i += READ_CONCURRENCY) {
      await Promise.all(
        reading.slice(i, i + READ_CONCURRENCY).map(async (f) => {
          try {
            const text = await readRepoFile(ctx, f.path, headSha);
            if (text === null) throw new Error('not found at the head');
            head.set(f.path, Buffer.from(text, 'utf8'));
            const routes = await fileRoutes(this.treeSitter, f.path, text);
            if (routes) headRoutes.set(f.path, routes);
            else headRoutes.delete(f.path);
          } catch (error) {
            warnings.push(t('agent.drift.api.headUnread', { path: f.path }));
            this.logger.warn(`could not read ${f.path} at ${headSha.slice(0, 7)}: ${(error as Error).message}`);
          }
        }),
      );
    }

    // Tied only through a spec it edits or a file that declares a route,
    // before the change or after it.
    const touchesRoutes = changed.some((f) =>
      [f.path, f.previousPath].some((p) => !!p && (!!baseRoutes.get(p)?.routes.length || !!headRoutes.get(p)?.routes.length)),
    );
    const baseSpecs = await this.specStates(base, row, linked, locale, warnings);
    const headSpecs = touchesSpecs ? await this.specStates(head, row, linked, locale, []) : baseSpecs;
    const specChanged = (id: string) => baseSpecs.get(id)?.version !== headSpecs.get(id)?.version;
    if (!touchesRoutes && !linked.some((s) => specChanged(s.documentId))) return null;

    const baseInventory = inventoryOf(baseRoutes);
    const headInventory = inventoryOf(headRoutes);
    const supported = baseInventory.routes.length > 0 || headInventory.routes.length > 0;
    // Both sides compare the specs that exist at the head; one gone at the
    // head has nothing left to drift from.
    const checked = linked.filter((s) => headSpecs.has(s.documentId));
    const before = compareSpecs(
      checked.map((s) => underCheck(s, baseSpecs.get(s.documentId) ?? headSpecs.get(s.documentId)!)),
      baseInventory,
      supported,
    );
    const after = compareSpecs(checked.map((s) => underCheck(s, headSpecs.get(s.documentId)!)), headInventory, supported);

    const specs = checked.map((s, i) => {
      const introduced = introducedMismatches(before[i], after[i]);
      let changes: ApiSpecDiffSummary | undefined;
      if (specChanged(s.documentId)) {
        const next = headSpecs.get(s.documentId)!.parsed;
        const prev = baseSpecs.get(s.documentId)?.parsed ?? null;
        changes = diffApiSpecs(prev, next, s.slug ?? apiSpecSlug(next.keyHint ?? next.title)).summary;
      }
      return { ...report(s, headInventory, introduced), ...(changes ? { changes } : {}) };
    });
    return { specs, warnings };
  }

  // --- internals ---

  private async eligible(connectorId: string, workspaceId: string): Promise<Connector> {
    const row = await this.connectors.require(connectorId);
    if (row.workspaceId !== workspaceId) throw new NotFoundException(t('error.connector.notFound', { id: connectorId }));
    if (!REPO_CONNECTOR_KINDS.has(row.kind)) throw new BadRequestException(t('error.code.notARepository', { name: row.name }));
    if (!row.enabled) throw new BadRequestException(t('error.code.connectorDisabled', { name: row.name }));
    return row;
  }

  /** The whole repository: the cached snapshot when it is the whole repository, a fresh archive when it is a `subdir`. */
  private async archive(row: Connector): Promise<Map<string, Uint8Array>> {
    const ctx = await this.connectors.contextFor(row, async () => undefined);
    if (!repoSubdir(ctx)) return (await this.snapshots.open(row.id, row.workspaceId)).files;
    return (await downloadRepoArchive(ctx)).files;
  }

  private routes(files: Map<string, Uint8Array>): Promise<Map<string, FileRoutes>> {
    let reading = inventories.get(files);
    if (!reading) {
      reading = this.readRoutes(files);
      inventories.set(files, reading);
    }
    // A copy: the pull request overlay edits its own map, never the cached one.
    return reading.then((m) => new Map(m));
  }

  private async readRoutes(files: Map<string, Uint8Array>): Promise<Map<string, FileRoutes>> {
    const out = new Map<string, FileRoutes>();
    for (const [path, bytes] of files) {
      const language = this.treeSitter.languageForPath(path);
      if (!language) continue;
      const text = Buffer.from(bytes).toString('utf8');
      if (!mayDeclareRoutes(language, text)) continue;
      const routes = await fileRoutes(this.treeSitter, path, text);
      if (routes && (routes.routes.length || routes.globalPrefixes.length || routes.dynamic)) out.set(path, routes);
    }
    return out;
  }

  /** Each linked spec parsed from `files`, by document; one that is gone or will not parse is a warning. */
  private async specStates(
    files: Map<string, Uint8Array>,
    row: Connector,
    linked: readonly LinkedSpec[],
    locale: Locale,
    warnings: string[],
  ): Promise<Map<string, SpecState>> {
    const inRepo = repoSpecFiles(files, (row.config ?? {}) as Record<string, unknown>, locale);
    const out = new Map<string, SpecState>();
    for (const spec of linked) {
      const file = inRepo.get(spec.specPath);
      if (!file || file.kind !== 'openapi') {
        warnings.push(t('agent.drift.api.specGone', { path: spec.specPath }));
        continue;
      }
      try {
        out.set(spec.documentId, { parsed: await parseApiSpec(file.text, 'openapi', this.limits), version: file.version });
      } catch (error) {
        warnings.push(t('agent.drift.api.specUnparsed', { path: spec.specPath, error: (error as Error).message.slice(0, 200) }));
      }
    }
    return out;
  }
}

function inventoryOf(files: Map<string, FileRoutes>): RouteInventory {
  const inventory: RouteInventory = { routes: [], globalPrefixes: [], dynamic: 0 };
  for (const f of files.values()) {
    inventory.routes.push(...f.routes);
    inventory.globalPrefixes.push(...f.globalPrefixes);
    inventory.dynamic += f.dynamic;
  }
  return inventory;
}

function underCheck(spec: LinkedSpec, state: SpecState): SpecUnderCheck {
  return {
    documentId: spec.documentId,
    title: spec.title,
    specPath: spec.specPath,
    operations: state.parsed.operations
      .filter((o) => o.protocol === 'http' && o.method)
      .map((o) => ({ method: o.method!, path: o.path })),
  };
}

function report(spec: LinkedSpec, inventory: RouteInventory, mismatches: ApiDriftSpec['mismatches']): ApiDriftSpec {
  return {
    documentId: spec.documentId,
    title: spec.title,
    specPath: spec.specPath,
    routes: inventory.routes.length,
    frameworks: [...new Set(inventory.routes.map((r) => r.framework))].sort(),
    dynamic: inventory.dynamic,
    mismatches: mismatches.slice(0, MAX_DRIFT_MISMATCHES),
    mismatchTotal: mismatches.length,
  };
}
