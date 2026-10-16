import { Injectable, Logger } from '@nestjs/common';
import type { ComponentDeclarationView, ComponentDeclarationWarning } from '@knowledge/contracts';
import { readComponentFrontmatter } from '../common/frontmatter.js';
import { GraphService } from '../graph/graph.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  componentKeyFor,
  componentUsageEdges,
  resolveDeclaration,
  type CodeConnectorRef,
  type ResolvedDeclaration,
} from './component-match.js';

/**
 * Component pages (#236, phase 2): what a page declares it documents, and the
 * `code` edges derived from it.
 *
 * Two writers, one table. Ingestion records a page's declaration when its
 * default-branch head indexes; a codebase pull re-resolves every declaration
 * in the workspace (a connector may have appeared, or gone) and rebuilds the
 * derived edges from the fresh import index. Both run in the worker, which is
 * fine here: nothing is published and nothing is attributed to a person.
 */
@Injectable()
export class ComponentsService {
  private readonly logger = new Logger(ComponentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: GraphService,
  ) {}

  /**
   * Record the declaration of a page's default-branch head, or drop it when the
   * head no longer has one. Returns whether anything that feeds the derived
   * edges changed, so the caller rebuilds only then.
   */
  async record(input: {
    workspaceId: string;
    documentId: string;
    revisionId: string;
    title: string;
    frontmatter: Record<string, unknown>;
  }): Promise<boolean> {
    const block = readComponentFrontmatter(input.frontmatter);
    const before = await this.prisma.componentDeclaration.findUnique({ where: { documentId: input.documentId } });
    if (!block) {
      if (!before) return false;
      await this.prisma.componentDeclaration.deleteMany({ where: { documentId: input.documentId } });
      return true;
    }
    const component = componentKeyFor(block, input.frontmatter, input.title);
    const { connectorId, warning } = resolveDeclaration(block, await this.codeConnectors(input.workspaceId));
    const data = {
      workspaceId: input.workspaceId,
      revisionId: input.revisionId,
      componentKey: component.key,
      componentName: component.name,
      repository: block.repository,
      connectorId,
      paths: block.paths,
      symbols: block.symbols,
      warning,
    };
    await this.prisma.componentDeclaration.upsert({
      where: { documentId: input.documentId },
      create: { documentId: input.documentId, ...data },
      update: data,
    });
    return (
      !before ||
      before.componentKey !== data.componentKey ||
      before.componentName !== data.componentName ||
      before.connectorId !== data.connectorId ||
      before.paths.join('\n') !== data.paths.join('\n') ||
      before.symbols.join('\n') !== data.symbols.join('\n')
    );
  }

  /**
   * Re-resolve the workspace's declarations and replace its `code` edges.
   * Called after every codebase pull and after a declaration changes. Returns
   * the number of edges written.
   */
  async rebuild(workspaceId: string): Promise<number> {
    const connectors = await this.codeConnectors(workspaceId);
    const rows = await this.prisma.componentDeclaration.findMany({ where: { workspaceId } });

    for (const row of rows) {
      const next = resolveDeclaration(row, connectors);
      if (next.connectorId === row.connectorId && next.warning === row.warning) continue;
      await this.prisma.componentDeclaration.update({ where: { documentId: row.documentId }, data: next });
      row.connectorId = next.connectorId;
      row.warning = next.warning;
    }

    const used = connectors.filter((c) => rows.some((r) => r.connectorId === c.id));
    const inputs = await Promise.all(
      used.map(async (connector) => {
        const [imports, links] = await Promise.all([
          this.prisma.codeImport.findMany({
            where: { connectorId: connector.id },
            select: { importerPath: true, importedPath: true, names: true },
          }),
          this.prisma.connectorLink.findMany({
            where: { connectorId: connector.id, externalId: { startsWith: 'module:' } },
            select: { externalId: true, documentId: true },
          }),
        ]);
        return { connector, imports, links };
      }),
    );

    // An archived or deleted page neither declares nor documents anything the
    // graph should show.
    const candidates = new Set([...rows.map((r) => r.documentId), ...inputs.flatMap((i) => i.links.map((l) => l.documentId))]);
    const pages = new Map(
      (
        await this.prisma.document.findMany({
          where: { workspaceId, archivedAt: null, id: { in: [...candidates] } },
          select: { id: true, title: true },
        })
      ).map((d) => [d.id, d.title]),
    );

    const edges: Array<{ documentId: string; title: string; componentKey: string; componentName: string; usages: string[] }> = [];
    const names = new Map(rows.map((r) => [r.componentKey, r.componentName]));
    for (const { connector, imports, links } of inputs) {
      const declared: ResolvedDeclaration[] = rows
        .filter((r) => r.connectorId === connector.id && pages.has(r.documentId))
        .map((r) => ({ documentId: r.documentId, componentKey: r.componentKey, paths: r.paths, symbols: r.symbols }));
      const modules = links
        .filter((l) => pages.has(l.documentId))
        .map((l) => ({ dir: l.externalId.slice('module:'.length), documentId: l.documentId }));
      for (const [documentId, byKey] of componentUsageEdges(declared, imports, modules)) {
        for (const [componentKey, usages] of byKey) {
          edges.push({
            documentId,
            title: pages.get(documentId)!,
            componentKey,
            componentName: names.get(componentKey) ?? componentKey,
            usages,
          });
        }
      }
    }

    const written = await this.graph.replaceCodeFacts({ workspaceId, edges });
    this.logger.log(`code edges rebuilt for workspace ${workspaceId}: ${written}`);
    return written;
  }

  /** The page's declaration as resolved, or null when its head declares none. */
  async view(documentId: string): Promise<ComponentDeclarationView | null> {
    const row = await this.prisma.componentDeclaration.findUnique({
      where: { documentId },
      include: { connector: { select: { id: true, name: true } } },
    });
    if (!row) return null;
    return {
      documentId: row.documentId,
      componentKey: row.componentKey,
      repository: row.repository,
      connector: row.connector,
      paths: row.paths,
      symbols: row.symbols,
      // A connector deleted since the last resolve leaves a null id behind the
      // FK; until the next pull re-resolves, that is "no connector" too.
      warning: (row.warning as ComponentDeclarationWarning | null) ?? (row.connectorId ? null : 'unknown-repository'),
      revisionId: row.revisionId,
    };
  }

  private async codeConnectors(workspaceId: string): Promise<CodeConnectorRef[]> {
    const rows = await this.prisma.connector.findMany({
      where: { workspaceId, kind: 'codebase' },
      select: { id: true, config: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.flatMap((r) => {
      const repoUrl = (r.config as Record<string, unknown> | null)?.repoUrl;
      return typeof repoUrl === 'string' && repoUrl.trim() ? [{ id: r.id, repoUrl }] : [];
    });
  }
}
