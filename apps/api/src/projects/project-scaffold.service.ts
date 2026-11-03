import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  blueprintText,
  nextChildTitle,
  type Blueprint,
  type BlueprintCollection,
  type BlueprintConventions,
  type BlueprintNode,
  type Locale,
  type ScaffoldProjectResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { PermissionService } from '../permissions/permission.service.js';
import { AclEventsService } from '../permissions/acl-events.service.js';
import { normalizeAliases } from '../glossary/glossary.service.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import { SCAFFOLD_ORIGIN } from '../common/scaffold-stub.js';
import { parseBlueprint } from '../blueprints/blueprint.schema.js';
import { BlueprintsService } from '../blueprints/blueprints.service.js';
import type { Principal } from '../auth/principal.js';
import type { ScaffoldProjectDto } from './projects.dto.js';
import { ProjectsService } from './projects.service.js';
import { t, withLocale } from '../i18n/t.js';

/** Where the pages go, and in which language they are written. */
interface Target {
  workspaceId: string;
  projectId: string;
  locale: Locale;
  authorId: string;
}

/**
 * Creates a project from a blueprint (#716): the project row, its conventions
 * and every page, in one PG transaction — a failure anywhere leaves nothing.
 *
 * Pages are written through `DocumentsService.createDocument`, which joins this
 * boundary: each page's source reaches object storage before the commit, and
 * its ingestion job row is the outbox, enqueued only once the commit lands.
 * Each first revision is then stamped `origin = 'scaffold'`, which is what
 * makes the page a scaffold stub (`common/scaffold-stub.ts`) until someone
 * writes it. Pages are published (`visibility: 'workspace'`), never private
 * drafts: a skeleton nobody else can see is not a structure.
 *
 * With `parentId` the tree goes under that page of its existing project and
 * no conventions are written: that project already has its own, and
 * replacing its styleguide would be a destructive side effect of adding pages.
 */
@Injectable()
export class ProjectScaffoldService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
    private readonly documents: DocumentsService,
    private readonly templates: TemplatesService,
    private readonly skills: AiSkillsService,
    private readonly permissions: PermissionService,
    private readonly aclEvents: AclEventsService,
    private readonly blueprints: BlueprintsService,
  ) {}

  /** The blueprint a request names: a built-in or saved one by key, or an inline one parsed by the one schema. */
  async resolve(dto: Pick<ScaffoldProjectDto, 'workspaceId' | 'blueprintKey' | 'blueprint'>): Promise<Blueprint> {
    if (!dto.blueprintKey === !dto.blueprint) throw new BadRequestException(t('error.blueprint.oneSource'));
    return dto.blueprint ? parseBlueprint(dto.blueprint) : this.blueprints.resolve(dto.workspaceId, dto.blueprintKey!);
  }

  async scaffold(dto: ScaffoldProjectDto, blueprint: Blueprint, principal: Principal): Promise<ScaffoldProjectResponse> {
    const { workspaceId, locale } = dto;
    const authorId = principal.userId;
    const scope = await this.permissions.scopeFor(principal, workspaceId);

    let parent: { id: string; projectId: string } | null = null;
    if (dto.parentId) {
      parent = await this.prisma.document.findFirst({
        where: { id: dto.parentId, workspaceId },
        select: { id: true, projectId: true },
      });
      if (!parent) throw new NotFoundException(t('error.document.notFound', { id: dto.parentId }));
      // Placing a page under a node is editing that node (#76).
      await this.permissions.requireCreateUnder(scope, { projectId: parent.projectId, parentId: parent.id });
    }

    // `withLocale` so built-in templates render their skeletons in the chosen language.
    const { projectId, pageCount } = await withLocale(locale, () =>
      this.prisma.withTransaction(
        async () => {
          const projectId =
            parent?.projectId ??
            (await this.projects.create({ workspaceId, name: dto.name!, description: dto.description }, authorId)).project
              .projectId;
          const target: Target = { workspaceId, projectId, locale, authorId };
          if (!parent) await this.applyFace(projectId, dto, authorId);
          if (!parent && blueprint.conventions) await this.writeConventions(target, blueprint.conventions, dto.name!);
          const pageCount = await this.writeTree(target, blueprint.tree, parent?.id ?? null, undefined);
          return { projectId, pageCount };
        },
        // Every page is a storage round trip or three; a large blueprint takes seconds.
        { timeout: 60_000, maxWait: 10_000 },
      ),
    );
    return { project: await this.projects.get(projectId, scope), pageCount };
  }

  /**
   * The project's emoji and restriction, before any page: a page is born under
   * its project's restriction (`recomputeRestrictedBy` in `createDocument`), so
   * a restricted scaffold is never readable workspace-wide, not even between
   * the commit and a later PUT. The creator gets `manage`, as the access PUT's
   * self-lockout check would demand of them, and live gateways drop their
   * cached scopes once it commits — the `createDocument` private-draft rule.
   */
  private async applyFace(projectId: string, dto: ScaffoldProjectDto, authorId: string): Promise<void> {
    const emoji = dto.avatarEmoji?.trim();
    if (!dto.restricted && !emoji) return;
    await this.prisma.project.update({
      where: { id: projectId },
      data: {
        ...(emoji ? { avatarEmoji: emoji, avatarColor: dto.avatarColor ?? null, avatarUpdatedAt: new Date() } : {}),
        ...(dto.restricted ? { restricted: true } : {}),
      },
    });
    if (!dto.restricted) return;
    await this.prisma.accessGrant.create({
      data: {
        workspaceId: dto.workspaceId,
        resourceType: 'project',
        resourceId: projectId,
        subjectType: 'user',
        subjectId: authorId,
        level: 'manage',
        createdBy: authorId,
      },
    });
    this.prisma.onCommit(() => this.aclEvents.changed(dto.workspaceId, authorId));
  }

  /** Depth-first, so a page's parent always exists when it is written. Returns pages written. */
  private async writeTree(
    target: Target,
    nodes: BlueprintNode[],
    parentId: string | null,
    rule: BlueprintCollection | undefined,
  ): Promise<number> {
    const pattern = blueprintText(rule?.childTitlePattern, target.locale);
    const siblings: string[] = [];
    let written = 0;
    for (const node of nodes) {
      const name = blueprintText(node.title, target.locale).trim();
      // Under a collection, an initial item is titled and shaped by its rule.
      const title = pattern ? nextChildTitle(pattern, siblings, name) : name;
      siblings.push(title);
      const templateRef = node.templateRef ?? rule?.childTemplateRef;
      const created = await this.documents.createDocument(
        {
          workspaceId: target.workspaceId,
          projectId: target.projectId,
          ...(parentId ? { parentId } : {}),
          title,
          ...(node.category ? { category: node.category } : {}),
          visibility: 'workspace',
          content: { mode: 'inline', format: 'markdown', text: await this.skeleton(target, node, title, templateRef, parentId) },
          ...(templateRef ? { template: { ref: templateRef } } : {}),
        },
        target.authorId,
      );
      await this.prisma.documentRevision.update({ where: { id: created.revisionId }, data: { origin: SCAFFOLD_ORIGIN } });
      if (node.collection) {
        await this.prisma.document.update({
          where: { id: created.documentId },
          data: {
            childTemplateRef: node.collection.childTemplateRef ?? null,
            childTitlePattern: blueprintText(node.collection.childTitlePattern, target.locale) || null,
          },
        });
      }
      written += 1 + (await this.writeTree(target, node.children ?? [], created.documentId, node.collection));
    }
    return written;
  }

  /**
   * A template node starts as the template's skeleton, declared placeholders
   * left as `{{name}}` for whoever fills it. Any other node is its title, its
   * guidance as a note panel, then its heading skeleton.
   */
  private async skeleton(
    target: Target,
    node: BlueprintNode,
    title: string,
    templateRef: string | undefined,
    parentId: string | null,
  ): Promise<string> {
    if (templateRef) {
      const d = await this.templates.defaults({
        workspaceId: target.workspaceId,
        ref: templateRef,
        title,
        projectId: target.projectId,
        ...(parentId ? { parentId } : {}),
        authorId: target.authorId,
        live: true,
      });
      return composeFrontmatter(d.skeleton, { ...d.frontmatter, ...(d.tags.length ? { tags: d.tags } : {}) });
    }
    const guidance = blueprintText(node.guidance, target.locale).trim();
    const body = blueprintText(node.body, target.locale).trim();
    return `${[`# ${title}`, guidance && `> [!NOTE]\n> ${guidance.replace(/\n/g, '\n> ')}`, body].filter(Boolean).join('\n\n')}\n`;
  }

  private async writeConventions(target: Target, c: BlueprintConventions, projectName: string): Promise<void> {
    const { workspaceId, projectId, authorId } = target;
    if (c.styleguide) {
      // Styleguide names are unique per workspace, across skills too.
      const taken = await this.prisma.aiSkill.findUnique({ where: { workspaceId_name: { workspaceId, name: projectName } } });
      await this.skills.upsertStyleguide(
        workspaceId,
        {
          projectId,
          name: taken ? `${projectName} (${projectId.slice(0, 8)})` : projectName,
          description: c.styleguide.description ?? '',
          rules: c.styleguide.rules,
        },
        authorId,
      );
    }
    for (const tpl of c.templates ?? []) {
      await this.templates.create(
        { workspaceId, projectId, name: tpl.name, source: tpl.source, description: tpl.description ?? null, icon: tpl.icon ?? null },
        authorId,
      );
    }
    // One term per spelling: `(project_id, term)` is unique.
    const terms = [...new Map((c.glossary ?? []).map((g) => [g.term.trim().toLowerCase(), g])).values()];
    if (terms.length) {
      await this.prisma.glossaryTerm.createMany({
        data: terms.map((g) => ({
          workspaceId,
          projectId,
          term: g.term.trim(),
          definition: g.definition.trim(),
          aliases: normalizeAliases(g.aliases, g.term),
          createdBy: authorId,
        })),
      });
    }
  }
}
