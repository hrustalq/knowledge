import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  STYLE_RULE_SEVERITIES,
  STYLE_RULE_TEXT_MAX,
  type BlueprintGlossaryTerm,
  type BlueprintNode,
  type BlueprintTemplate,
  type DeriveBlueprintResponse,
  type DocumentTreeNode,
  type Locale,
  type StyleRule,
} from '@knowledge/contracts';
import type { Principal } from '../auth/principal.js';
import { FeaturesService } from '../auth/features.service.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { wrapUntrusted } from '../common/untrusted.js';
import { DocumentsService } from '../documents/documents.service.js';
import { safeJson } from '../glossary/glossary.service.js';
import { t } from '../i18n/t.js';
import { PermissionService } from '../permissions/permission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseBlueprint } from './blueprint.schema.js';
import { deriveTree, headingsOf, titleLocale, type SourcePage } from './derive-rules.js';

const DEPTH = 3;
/** Object-storage reads one derive may make: BLUEPRINT_MAX_PAGES plus slack for folded leaves. */
const HEADING_READS = 300;
const RULES_MAX = 10;
const GUIDANCE_MAX = 500;

/**
 * A blueprint read off an existing project (#716), for a new project in
 * `workspaceId`. The source may sit in any workspace the caller belongs to and
 * is read under their `AccessScope` there: a restricted page they cannot open
 * contributes nothing, not even its title. Rules first (`derive-rules.ts`),
 * then one `scaffolder` call for the styleguide and page guidance when the
 * target workspace runs `assistant` — billed there, since that is where the
 * project is being made. A failed or refused call leaves the rules' result.
 */
@Injectable()
export class BlueprintDeriveService {
  private readonly logger = new Logger(BlueprintDeriveService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly documents: DocumentsService,
    private readonly features: FeaturesService,
    private readonly agents: AgentRegistryService,
    private readonly aiUsage: AiUsageService,
    private readonly client: AssistantClient,
  ) {}

  async derive(workspaceId: string, projectId: string, principal: Principal): Promise<DeriveBlueprintResponse> {
    const project = await this.prisma.project.findUnique({ where: { id: projectId } });
    if (!project) throw new NotFoundException(t('error.project.notFound', { id: projectId }));
    const source = project.workspaceId;
    // Membership in the source workspace and sight of the project: a refusal
    // carries no title (403 for a member, 404 for a guest or a stranger).
    await this.permissions.requireResource(principal, source, { type: 'project', id: projectId }, 'viewer', false);
    const scope = await this.permissions.scopeFor(principal, source);

    const { roots } = await this.documents.getTree(scope, projectId, { depth: DEPTH });
    const pages = await this.sourcePages(roots, { reads: 0 });
    const tree = deriveTree(pages);
    const lang = titleLocale(project.name);

    const sameWorkspace = source === workspaceId;
    const [templates, glossary] = await Promise.all([this.templates(source, projectId, sameWorkspace), sameWorkspace ? this.glossary(projectId) : []]);
    const styleguide = tree.length ? await this.draft(workspaceId, tree, principal) : null;

    const blueprint = parseBlueprint({
      name: { [lang]: project.name },
      ...(project.description ? { description: { [lang]: project.description.slice(0, 2_000) } } : {}),
      ...(project.avatarEmoji ? { icon: project.avatarEmoji } : {}),
      tree,
      ...(styleguide?.styleguide || templates.length
        ? { conventions: { ...(styleguide?.styleguide ? { styleguide: styleguide.styleguide } : {}), ...(templates.length ? { templates } : {}) } }
        : {}),
    });
    return { blueprint, glossary, drafted: styleguide !== null };
  }

  /** The tree as derive reads it: published pages only, each with its head's headings. */
  private async sourcePages(nodes: DocumentTreeNode[], budget: { reads: number }): Promise<SourcePage[]> {
    const live = nodes.filter((n) => !n.draftOwnerId);
    const rows = await this.prisma.document.findMany({ where: { id: { in: live.map((n) => n.documentId) } }, select: { id: true, templateRef: true } });
    const refs = new Map(rows.map((r) => [r.id, r.templateRef]));
    return Promise.all(
      live.map(async (n) => ({
        title: n.title,
        category: n.category,
        templateRef: refs.get(n.documentId) ?? null,
        // ponytail: past HEADING_READS pages only titles travel; batch the reads if big sources need headings throughout.
        headings: budget.reads++ < HEADING_READS ? await this.headings(n) : [],
        children: await this.sourcePages(n.children, budget),
      })),
    );
  }

  private async headings(node: DocumentTreeNode): Promise<string[]> {
    if (!node.headRevisionId || node.headRevisionStatus === 'draft') return [];
    try {
      const content = await this.documents.readContent(await this.documents.contentRevision(node.documentId));
      return headingsOf(content.markdown);
    } catch {
      return []; // A page whose bytes are unreadable still contributes its title.
    }
  }

  /**
   * Templates travel as version-1 project templates: the source project's own,
   * plus its workspace's when that is another workspace (in the same one they
   * are already offered). Built-in overrides and archived ones stay behind.
   */
  private async templates(workspaceId: string, projectId: string, sameWorkspace: boolean): Promise<BlueprintTemplate[]> {
    const rows = await this.prisma.pageTemplate.findMany({
      where: { workspaceId, builtInKey: null, archivedAt: null, OR: [{ projectId }, ...(sameWorkspace ? [] : [{ projectId: null }])] },
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
      orderBy: { name: 'asc' },
      take: 50,
    });
    return rows
      .filter((r) => r.versions[0])
      .map((r) => ({
        name: r.name,
        source: r.versions[0]!.source,
        ...(r.description ? { description: r.description } : {}),
        ...(r.icon ? { icon: r.icon } : {}),
      }));
  }

  private async glossary(projectId: string): Promise<BlueprintGlossaryTerm[]> {
    const rows = await this.prisma.glossaryTerm.findMany({ where: { projectId }, orderBy: { term: 'asc' }, take: 500 });
    return rows.map((r) => ({
      term: r.term,
      definition: r.definition,
      ...(Array.isArray(r.aliases) && r.aliases.length ? { aliases: r.aliases.filter((a): a is string => typeof a === 'string') } : {}),
    }));
  }

  /**
   * The scaffolder's draft, or null when the workspace runs no assistant, the
   * agent is off, the budget is spent or the call fails. Guidance lands on the
   * nodes in place; only ids this call handed out and known severities count.
   */
  private async draft(
    workspaceId: string,
    tree: BlueprintNode[],
    principal: Principal,
  ): Promise<{ styleguide: { description?: string; rules: StyleRule[] } | null } | null> {
    if ((await this.features.disabled(workspaceId)).includes('assistant')) return null;
    const agent = await this.agents.resolve(workspaceId, 'scaffolder');
    if (!agent.enabled || !agent.config.enabled) return null;

    const ids = new Map<string, BlueprintNode>();
    const lines: string[] = [];
    const outline = (nodes: BlueprintNode[], depth: number) => {
      for (const node of nodes) {
        const id = `n${ids.size + 1}`;
        ids.set(id, node);
        const title = Object.values(node.title)[0] ?? '';
        const shape = node.templateRef ?? Object.values(node.body ?? {})[0]?.replace(/\n\n/g, '; ') ?? '';
        const rule = node.collection ? ` [collection${node.collection.childTitlePattern ? `: ${Object.values(node.collection.childTitlePattern)[0]}…` : ''}]` : '';
        lines.push(`${'  '.repeat(depth)}${id}. ${title}${node.category ? ` (${node.category})` : ''}${rule}${shape ? ` — ${shape}` : ''}`);
        outline(node.children ?? [], depth + 1);
      }
    };
    outline(tree, 0);
    const lang: Locale = lines.filter((l) => titleLocale(l) === 'ru').length * 2 > lines.length ? 'ru' : 'en';

    try {
      await this.aiUsage.assertWithinBudget(workspaceId, principal.userId);
      const raw = await this.client.chat(
        { config: agent.config, userId: principal.userId, operation: 'blueprint-derive', locale: principal.locale },
        [
          { role: 'system', content: agent.instructions },
          {
            role: 'user',
            content: `Write in ${lang === 'ru' ? 'Russian' : 'English'}.\n\nThe project's outline:\n${wrapUntrusted(lines.join('\n'), 'blueprint-derive', 'page')}`,
          },
        ],
        { json: true },
      );
      const parsed = safeJson(raw) ?? {};
      const guidance = (parsed.guidance ?? {}) as Record<string, unknown>;
      for (const [id, text] of Object.entries(guidance)) {
        const node = ids.get(id);
        if (node && typeof text === 'string' && text.trim()) node.guidance = { [lang]: text.trim().slice(0, GUIDANCE_MAX) };
      }
      const sg = (parsed.styleguide ?? {}) as { description?: unknown; rules?: unknown };
      const rules: StyleRule[] = (Array.isArray(sg.rules) ? sg.rules : [])
        .filter((r): r is { text: string; severity?: unknown } => typeof r?.text === 'string' && r.text.trim() !== '')
        .slice(0, RULES_MAX)
        .map((r, i) => ({
          id: `rule-${i + 1}`,
          text: r.text.trim().slice(0, STYLE_RULE_TEXT_MAX),
          severity: (STYLE_RULE_SEVERITIES as readonly unknown[]).includes(r.severity) ? (r.severity as StyleRule['severity']) : 'warning',
          enabled: true,
        }));
      const description = typeof sg.description === 'string' ? sg.description.trim().slice(0, 2_000) : '';
      return { styleguide: rules.length ? { ...(description ? { description } : {}), rules } : null };
    } catch (e) {
      this.logger.warn(`blueprint derive: scaffolder call failed, rules only (${(e as Error).message})`);
      return null;
    }
  }
}
