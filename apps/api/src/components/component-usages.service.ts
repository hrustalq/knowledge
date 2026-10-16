import { Injectable, NotFoundException } from '@nestjs/common';
import type { CodeUsagePage, CodeUsagesResponse, ComponentDeclarationWarning } from '@knowledge/contracts';
import { LISTED_PAGE } from '../common/listed-page.js';
import { t } from '../i18n/t.js';
import type { AccessScope } from '../permissions/access-scope.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  DEFAULT_USAGE_LIMIT,
  coversFile,
  declaredChanges,
  documentingPages,
  importedPathPrefilter,
  overlayImports,
  resolveDeclaration,
  usageSites,
  type ChangedFile,
  type ImportRow,
} from './component-match.js';
import { ComponentsService } from './components.service.js';

/** What a pull request's head imports, laid over the index (`PullRequestService.headImports`). */
export interface ImportOverlay {
  rows: ImportRow[];
  replaced: string[];
  baseFiles: ReadonlySet<string>;
}

/** What a change touches through component declarations (#236, phase 4). */
export interface ChangeImpact {
  /** Component pages declaring a changed file, with the changed files they declare and their paths. */
  declared: Array<{ documentId: string; title: string; files: string[]; paths: string[] }>;
  /** Pages documenting a file that uses changed declared code, most usage files first. */
  affected: Array<{ documentId: string; title: string; sites: string[]; uses: string[] }>;
  /** Declared or affected pages the scope may not open — counted, never titled. */
  hiddenPages: number;
  /** Usage files no page documents, sorted. */
  undocumented: string[];
  /** The overlay the answer was computed with; null when it could not be read. */
  overlay: ImportOverlay | null;
}

interface Ask {
  connectorId: string | null;
  warning: ComponentDeclarationWarning | null;
  paths: string[];
  symbols: string[];
  /** The component page asking, never listed as documenting its own usages. */
  selfId: string | null;
  limit: number;
}

/**
 * Where a component's code is used (#236, phase 3), computed on every read
 * from the connector's import index — never written into a page.
 *
 * Paths are code, and the caller has already been let into the component page
 * (or the workspace), so every usage path is listed. Pages are not: each one
 * is checked against the caller's scope, and a page they may not open is a
 * count, never a title.
 */
@Injectable()
export class ComponentUsagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly components: ComponentsService,
    private readonly permissions: PermissionService,
  ) {}

  /** The usages of the component a page declares. `symbols`, when given, replaces the declared ones. */
  async forDocument(
    scope: AccessScope,
    documentId: string,
    opts: { symbols?: string[]; limit?: number } = {},
  ): Promise<CodeUsagesResponse> {
    const view = await this.components.view(documentId);
    if (!view) throw new NotFoundException(t('error.component.notDeclared', { id: documentId }));
    return this.answer(scope, {
      connectorId: view.warning ? null : (view.connector?.id ?? null),
      warning: view.warning,
      paths: view.paths,
      symbols: opts.symbols?.length ? opts.symbols : view.symbols,
      selfId: documentId,
      limit: opts.limit ?? DEFAULT_USAGE_LIMIT,
    });
  }

  /**
   * The usages of a file, directory or glob in one of the workspace's code
   * connectors, chosen by `repository` the way a declaration chooses one.
   */
  async forPath(
    scope: AccessScope,
    input: { path: string; repository?: string | null; symbols?: string[]; limit?: number },
  ): Promise<CodeUsagesResponse> {
    const paths = [input.path.trim().replace(/^\.?\//, '')].filter(Boolean);
    const { connectorId, warning } = resolveDeclaration(
      { repository: input.repository?.trim() || null, paths },
      await this.components.codeConnectors(scope.workspaceId),
    );
    return this.answer(scope, {
      connectorId,
      warning,
      paths,
      symbols: input.symbols ?? [],
      selfId: null,
      limit: input.limit ?? DEFAULT_USAGE_LIMIT,
    });
  }

  /**
   * The component pages a pull request's changed files are declared by, and
   * the pages documenting the code that uses them — the drift check's two new
   * ties (#236, phase 4). Null when no live declaration covers a changed file,
   * before `overlay` is asked for: a change that touches no component costs
   * one query.
   *
   * Usage is read from the default-branch index with the head's imports of
   * the changed files laid over it, so an importer the pull request adds
   * counts and one it removes does not. A failed overlay (`null`) leaves the
   * default branch's answer, which is still right about every unchanged file.
   */
  async forChange(
    scope: AccessScope,
    connectorId: string,
    files: readonly ChangedFile[],
    overlay: () => Promise<ImportOverlay | null>,
  ): Promise<ChangeImpact | null> {
    const declarations = await this.prisma.componentDeclaration.findMany({
      where: { connectorId, warning: null },
      select: { documentId: true, componentKey: true, paths: true, symbols: true },
    });
    if (!declarations.some((d) => declaredChanges(d.paths, files).length > 0)) return null;

    const links = await this.prisma.connectorLink.findMany({
      where: { connectorId, externalId: { startsWith: 'module:' } },
      select: { externalId: true, documentId: true },
    });
    const titles = new Map(
      (
        await this.prisma.document.findMany({
          where: {
            workspaceId: scope.workspaceId,
            archivedAt: null,
            ...LISTED_PAGE,
            id: { in: [...new Set([...declarations.map((d) => d.documentId), ...links.map((l) => l.documentId)])] },
          },
          select: { id: true, title: true },
        })
      ).map((d) => [d.id, d.title]),
    );
    const live = declarations.filter((d) => titles.has(d.documentId));
    const touched = live.map((d) => ({ ...d, files: declaredChanges(d.paths, files) })).filter((d) => d.files.length > 0);
    if (touched.length === 0) return null;
    const modules = links
      .filter((l) => titles.has(l.documentId))
      .map((l) => ({ dir: l.externalId.slice('module:'.length), documentId: l.documentId }));

    const changed = new Set(files.flatMap((f) => (f.previousPath ? [f.path, f.previousPath] : [f.path])));
    const head = await overlay();
    const base = await this.prisma.codeImport.findMany({
      where: { connectorId, importedPath: { in: [...changed] } },
      select: { importerPath: true, importedPath: true, names: true },
    });
    const rows = (head ? overlayImports(base, head.rows, head.replaced) : base).filter((r) => changed.has(r.importedPath));

    const affected = new Map<string, { sites: Set<string>; uses: Set<string> }>();
    const undocumented = new Set<string>();
    for (const d of touched) {
      for (const site of usageSites(d.paths, d.symbols, rows)) {
        const pages = documentingPages(site.path, live, modules).filter((id) => id !== d.documentId);
        if (pages.length === 0) undocumented.add(site.path);
        for (const id of pages) {
          const entry = affected.get(id) ?? { sites: new Set<string>(), uses: new Set<string>() };
          entry.sites.add(site.path);
          for (const used of site.imports) entry.uses.add(used.path);
          affected.set(id, entry);
        }
      }
    }

    const visible = await this.permissions.visibleDocumentIds(scope, [...touched.map((d) => d.documentId), ...affected.keys()]);
    const hidden = new Set([...touched.map((d) => d.documentId), ...affected.keys()].filter((id) => !visible.has(id)));
    const sorted = (set: Set<string>) => [...set].sort();
    return {
      declared: touched
        .filter((d) => visible.has(d.documentId))
        .map((d) => ({ documentId: d.documentId, title: titles.get(d.documentId)!, files: d.files, paths: d.paths })),
      affected: [...affected]
        .filter(([id]) => visible.has(id))
        .map(([id, e]) => ({ documentId: id, title: titles.get(id)!, sites: sorted(e.sites), uses: sorted(e.uses) }))
        .sort((a, b) => b.sites.length - a.sites.length || a.title.localeCompare(b.title)),
      hiddenPages: hidden.size,
      undocumented: sorted(undocumented),
      overlay: head,
    };
  }

  private async answer(scope: AccessScope, ask: Ask): Promise<CodeUsagesResponse> {
    const empty: CodeUsagesResponse = {
      connector: null,
      headSha: null,
      paths: ask.paths,
      symbols: ask.symbols,
      components: [],
      hiddenComponents: 0,
      usages: [],
      truncated: 0,
      warning: ask.warning,
    };
    if (!ask.connectorId) return empty;
    const connectorId = ask.connectorId;

    const prefilter = importedPathPrefilter(ask.paths);
    const [connector, rows, declarations, links] = await Promise.all([
      this.prisma.connector.findUnique({ where: { id: connectorId }, select: { id: true, name: true } }),
      this.prisma.codeImport.findMany({
        where: { connectorId, ...(prefilter ? { OR: prefilter.map((importedPath) => ({ importedPath })) } : {}) },
        select: { importerPath: true, importedPath: true, names: true, headSha: true },
      }),
      this.prisma.componentDeclaration.findMany({
        where: { connectorId, warning: null },
        select: { documentId: true, componentKey: true, paths: true, symbols: true },
      }),
      this.prisma.connectorLink.findMany({
        where: { connectorId, externalId: { startsWith: 'module:' } },
        select: { externalId: true, documentId: true },
      }),
    ]);
    if (!connector) return empty;
    const headSha =
      rows[0]?.headSha ??
      (await this.prisma.codeImport.findFirst({ where: { connectorId }, select: { headSha: true } }))?.headSha ??
      null;

    // A page that is archived, or still head-less behind a merge request,
    // documents nothing a reader should be sent to — the rule the edges follow.
    const candidates = new Set([...declarations.map((d) => d.documentId), ...links.map((l) => l.documentId)]);
    const titles = new Map(
      (
        await this.prisma.document.findMany({
          where: { workspaceId: scope.workspaceId, archivedAt: null, ...LISTED_PAGE, id: { in: [...candidates] } },
          select: { id: true, title: true },
        })
      ).map((d) => [d.id, d.title]),
    );
    const live = declarations.filter((d) => titles.has(d.documentId));
    const modules = links
      .filter((l) => titles.has(l.documentId))
      .map((l) => ({ dir: l.externalId.slice('module:'.length), documentId: l.documentId }));

    const sites = usageSites(ask.paths, ask.symbols, rows);
    const shown = sites.slice(0, ask.limit);
    const pagesBySite = shown.map((s) => documentingPages(s.path, live, modules).filter((id) => id !== ask.selfId));
    const componentIds = live
      .filter((d) => d.documentId !== ask.selfId && ask.paths.some((p) => coversFile(d.paths, p)))
      .map((d) => d.documentId);

    const visible = await this.permissions.visibleDocumentIds(scope, [...pagesBySite.flat(), ...componentIds]);
    const split = (ids: string[]): { pages: CodeUsagePage[]; hidden: number } => {
      const unique = [...new Set(ids)];
      const pages = unique.filter((id) => visible.has(id)).map((id) => ({ id, title: titles.get(id)! }));
      return { pages, hidden: unique.length - pages.length };
    };

    const components = split(componentIds);
    return {
      connector,
      headSha,
      paths: ask.paths,
      symbols: ask.symbols,
      components: components.pages,
      hiddenComponents: components.hidden,
      usages: shown.map((site, i) => {
        const { pages, hidden } = split(pagesBySite[i]);
        return { ...site, pages, hiddenPages: hidden };
      }),
      truncated: sites.length - shown.length,
      warning: null,
    };
  }
}
