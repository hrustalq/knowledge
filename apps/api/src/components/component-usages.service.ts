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
  documentingPages,
  importedPathPrefilter,
  resolveDeclaration,
  usageSites,
} from './component-match.js';
import { ComponentsService } from './components.service.js';

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
