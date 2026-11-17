import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  blueprintText,
  levelOf,
  ownedAgentKey,
  type BlueprintLevel,
  type Locale,
  type MethodologyPreviewResponse,
  type ProjectLevelsResponse,
  type ProjectMethodologyResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { BlueprintsService } from '../blueprints/blueprints.service.js';
import { MethodologyMaterializerService } from '../blueprints/methodology-materializer.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { visibilityWhere, type AccessScope } from '../permissions/access-scope.js';
import { LISTED_PAGE } from '../common/listed-page.js';
import type { Principal } from '../auth/principal.js';
import { currentLocale, t } from '../i18n/t.js';
import { projectLevels, projectScope } from './methodology-scope.js';
import { missingSections } from './methodology-preview.js';
import { ProjectScaffoldService } from './project-scaffold.service.js';

/**
 * A project's methodology (#1125): link, switch, unlink, and what a switch
 * would add. Linking writes `projects.blueprint_id` and the sections a person
 * confirmed, nothing else: the methodology's conventions are read live
 * through `projectScope`, and no page is ever deleted, moved or edited.
 */
@Injectable()
export class ProjectMethodologyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blueprints: BlueprintsService,
    private readonly materializer: MethodologyMaterializerService,
    private readonly scaffold: ProjectScaffoldService,
    private readonly permissions: PermissionService,
  ) {}

  async get(projectId: string): Promise<ProjectMethodologyResponse> {
    const { blueprintId } = await projectScope(this.prisma, projectId);
    const entry = blueprintId ? await this.blueprints.linked(blueprintId) : null;
    if (!entry) return { projectId, methodology: null };
    const b = entry.blueprint;
    return {
      projectId,
      methodology: { key: entry.key, name: b.name, icon: b.icon ?? null, builtIn: entry.builtIn, enabled: entry.enabled, levels: b.levels ?? [] },
    };
  }

  /** The project's levels in order, each with the pages the caller can see at it (#1126). */
  async levels(projectId: string, principal: Principal, locale: Locale = currentLocale()): Promise<ProjectLevelsResponse> {
    const { workspaceId } = await this.requireProject(projectId);
    const levels = (await projectLevels(this.prisma, [projectId])).get(projectId) ?? [];
    if (!levels.length) return { projectId, levels: [] };
    const { blueprintId } = await projectScope(this.prisma, projectId);
    const counts = await this.levelCounts(projectId, await this.permissions.scopeFor(principal, workspaceId), levels, locale);
    return {
      projectId,
      levels: levels.map((l, i) => ({
        key: l.key,
        name: counts[i]!.name,
        description: blueprintText(l.description, locale) || null,
        agentKey: l.agentKey ?? null,
        agent: l.agentKey && blueprintId ? ownedAgentKey(l.agentKey, blueprintId) : null,
        pages: counts[i]!.pages,
      })),
    };
  }

  async preview(projectId: string, key: string, principal: Principal, locale: Locale = currentLocale()): Promise<MethodologyPreviewResponse> {
    const { workspaceId } = await this.requireProject(projectId);
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    const blueprint = await this.blueprints.resolve(workspaceId, key);
    const sections = missingSections(await this.topPages(projectId, scope), blueprint.tree, locale);
    return {
      blueprintKey: key,
      sections: sections.map(({ id, title, parentTitle, pages }) => ({ id, title, parentTitle, pages })),
      levels: await this.levelCounts(projectId, scope, blueprint.levels ?? [], locale),
    };
  }

  /**
   * Link `key` (or unlink with null), then create the confirmed sections, in
   * one transaction. Linking materializes the methodology in the workspace
   * first — idempotent, and what refreshes a built-in's rows after a release.
   */
  async set(
    projectId: string,
    input: { blueprintKey: string | null; sections?: string[]; locale?: Locale },
    principal: Principal,
  ): Promise<ProjectMethodologyResponse> {
    const { workspaceId } = await this.requireProject(projectId);
    if (input.blueprintKey === null) {
      await this.prisma.project.update({ where: { id: projectId }, data: { blueprintId: null } });
      return this.get(projectId);
    }
    const key = input.blueprintKey;
    const locale = input.locale ?? currentLocale();
    const scope = await this.permissions.scopeFor(principal, workspaceId);
    await this.prisma.withTransaction(
      async () => {
        const link = await this.blueprints.rowFor(workspaceId, key, principal.userId);
        // ponytail: a built-in's rows refresh on (re)link or save only; a release that changes a built-in
        // methodology reaches already-linked projects when one is relinked. Add a boot-time sweep if that bites.
        await this.materializer.materialize(workspaceId, link.id, link.blueprint, principal.userId);
        await this.prisma.project.update({ where: { id: projectId }, data: { blueprintId: link.id } });

        const wanted = new Set(input.sections ?? []);
        if (!wanted.size) return;
        const offered = missingSections(await this.topPages(projectId, scope), link.blueprint.tree, locale).filter((s) => wanted.has(s.id));
        const unknown = [...wanted].find((id) => !offered.some((s) => s.id === id));
        if (unknown) throw new BadRequestException(t('error.blueprint.unknownSection', { id: unknown }));
        for (const s of offered) await this.permissions.requireCreateUnder(scope, { projectId, ...(s.parentId ? { parentId: s.parentId } : {}) });
        await this.scaffold.writeSections({ workspaceId, projectId, locale, authorId: principal.userId }, offered);
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    return this.get(projectId);
  }

  /** How many of the project's pages each level counts, by the template they were made from. */
  async levelCounts(projectId: string, scope: AccessScope, levels: readonly BlueprintLevel[], locale: Locale = currentLocale()) {
    const counts = new Map<string, number>();
    if (levels.length) {
      const rows = await this.prisma.document.groupBy({
        by: ['templateRef'],
        where: { projectId, archivedAt: null, templateRef: { not: null }, ...LISTED_PAGE, AND: [visibilityWhere(scope)] },
        _count: { _all: true },
      });
      for (const row of rows) {
        const level = levelOf(row.templateRef, levels);
        if (level) counts.set(level.key, (counts.get(level.key) ?? 0) + row._count._all);
      }
    }
    return levels.map((l) => ({ key: l.key, name: blueprintText(l.name, locale), pages: counts.get(l.key) ?? 0 }));
  }

  /** Root pages and their children the caller can see: what sections are matched against. */
  private topPages(projectId: string, scope: AccessScope) {
    return this.prisma.document.findMany({
      where: { projectId, depth: { lte: 1 }, archivedAt: null, ...LISTED_PAGE, AND: [visibilityWhere(scope)] },
      select: { id: true, title: true, parentId: true },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
    });
  }

  private async requireProject(projectId: string): Promise<{ workspaceId: string }> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId }, select: { workspaceId: true } });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    return project;
  }
}
