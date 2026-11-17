import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { blueprintText, ownedAgentKey, type Blueprint } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { WorkflowsService } from '../workflows/workflows.service.js';
import { AiSkillsService } from '../ai/ai-skills.service.js';
import { normalizeAliases, readAliases } from '../glossary/glossary.service.js';
import { currentLocale } from '../i18n/t.js';
import { AgentRegistryService } from '../agents/agent-registry.service.js';

/** jsonb stores keys in its own order, so compare a key-sorted form. */
export const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1))) : v,
  );
const same = (a: unknown, b: unknown) => canonical(a ?? null) === canonical(b ?? null);

/**
 * The stored name of a methodology's workflow or styleguide (#1121). Both
 * tables are unique on (workspace, name), so an owned row carries the
 * blueprint's short id, the scaffold's styleguide-clash precedent — a
 * workspace row with the declared name keeps it. Deterministic, so the next
 * save finds the row again however the blueprint is renamed.
 */
export const ownedName = (name: string, blueprintId: string) => `${name.trim()} (${blueprintId.slice(0, 8)})`;

const DEFAULT_TRIGGER = { manual: true, autoStart: false, events: [], categories: [] };

/**
 * Writes the rows a methodology owns in one workspace (#1121): its templates,
 * workflows, styleguide and glossary terms, each with `blueprint_id` set and
 * no project, so every project linked to it reads them live. Idempotent:
 * an unchanged blueprint writes nothing. A row the blueprint no longer
 * declares is archived (template) or disabled (workflow, styleguide, term),
 * never deleted, so pages and runs pinned to it keep resolving.
 *
 * Runs inside the caller's transaction when there is one (`withTransaction`).
 */
@Injectable()
export class MethodologyMaterializerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly templates: TemplatesService,
    private readonly workflows: WorkflowsService,
    private readonly skills: AiSkillsService,
    private readonly registry: AgentRegistryService,
  ) {}

  /** Returns how many rows it wrote. */
  async materialize(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    return this.prisma.withTransaction(async () => {
      // In order, one transaction connection: templates first, since a workflow step may name one.
      let writes = await this.writeTemplates(workspaceId, blueprintId, blueprint, actorId);
      writes += await this.writeWorkflows(workspaceId, blueprintId, blueprint, actorId);
      writes += await this.writeStyleguide(workspaceId, blueprintId, blueprint, actorId);
      writes += await this.writeGlossary(workspaceId, blueprintId, blueprint, actorId);
      const agents = await this.writeAgents(workspaceId, blueprintId, blueprint, actorId);
      // The registry caches override rows for 30 s: the next turn must see the new instructions.
      if (agents) this.prisma.onCommit(async () => this.registry.invalidate(workspaceId));
      return writes + agents;
    });
  }

  private async writeTemplates(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    const rows = await this.prisma.pageTemplate.findMany({ where: { workspaceId, blueprintId, builtInKey: null } });
    let writes = 0;
    const declared = new Set<string>();
    for (const tpl of blueprint.conventions?.templates ?? []) {
      const name = tpl.name.trim();
      declared.add(name.toLowerCase());
      const row = rows.find((r) => r.name.toLowerCase() === name.toLowerCase());
      if (!row) {
        await this.templates.create(
          { workspaceId, projectId: null, blueprintId, name, source: tpl.source, description: tpl.description ?? null, icon: tpl.icon ?? null },
          actorId,
        );
        writes += 1;
        continue;
      }
      const current = await this.prisma.pageTemplateVersion.findUnique({
        where: { templateId_version: { templateId: row.id, version: row.currentVersion } },
        select: { source: true },
      });
      const patch = {
        ...(current?.source !== tpl.source ? { source: tpl.source } : {}),
        ...((tpl.description ?? null) !== row.description ? { description: tpl.description ?? null } : {}),
        ...((tpl.icon ?? null) !== row.icon ? { icon: tpl.icon ?? null } : {}),
      };
      if (Object.keys(patch).length) {
        await this.templates.update(row.id, patch, actorId);
        writes += 1;
      }
      if (row.archivedAt) {
        await this.templates.setArchived(row.id, false, actorId);
        writes += 1;
      }
    }
    for (const row of rows.filter((r) => !r.archivedAt && !declared.has(r.name.toLowerCase()))) {
      await this.templates.setArchived(row.id, true, actorId);
      writes += 1;
    }
    return writes;
  }

  private async writeWorkflows(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    const rows = await this.prisma.workflowDefinition.findMany({ where: { workspaceId, blueprintId } });
    let writes = 0;
    const declared = new Set<string>();
    for (const wf of blueprint.workflows ?? []) {
      const name = ownedName(wf.name, blueprintId);
      declared.add(name);
      const trigger = { ...DEFAULT_TRIGGER, ...(wf.trigger ?? {}) };
      const row = rows.find((r) => r.name === name);
      if (!row) {
        await this.workflows.create({ workspaceId, name, description: wf.description, graph: wf.graph, trigger, blueprintId }, actorId);
        writes += 1;
        continue;
      }
      const patch = {
        ...(!same(row.graph, wf.graph) ? { graph: wf.graph } : {}),
        ...(!same(row.trigger, trigger) ? { trigger } : {}),
        ...((wf.description ?? null) !== row.description ? { description: wf.description ?? null } : {}),
        ...(!row.enabled ? { enabled: true } : {}),
      };
      if (Object.keys(patch).length) {
        await this.workflows.update(row.id, patch, actorId);
        writes += 1;
      }
    }
    for (const row of rows.filter((r) => r.enabled && !declared.has(r.name))) {
      await this.workflows.update(row.id, { enabled: false }, actorId);
      writes += 1;
    }
    return writes;
  }

  private async writeStyleguide(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    const row = await this.prisma.aiSkill.findFirst({ where: { workspaceId, kind: 'styleguide', projectId: null, blueprintId } });
    const declared = blueprint.conventions?.styleguide;
    if (!declared) {
      if (!row?.enabled) return 0;
      await this.prisma.aiSkill.update({ where: { id: row.id }, data: { enabled: false } });
      return 1;
    }
    let writes = 0;
    const description = declared.description ?? '';
    if (!row || row.description !== description || !same(row.rules, declared.rules)) {
      const name = row?.name ?? ownedName(blueprintText(blueprint.name, currentLocale()) || 'Styleguide', blueprintId);
      await this.skills.upsertStyleguide(workspaceId, { projectId: null, blueprintId, name, description, rules: declared.rules }, actorId);
      writes += 1;
    }
    if (row && !row.enabled) {
      await this.prisma.aiSkill.update({ where: { id: row.id }, data: { enabled: true } });
      writes += 1;
    }
    return writes;
  }

  /**
   * Custom agents the methodology owns (#1127), keyed by `ownedAgentKey`. Its
   * text is the methodology's; `enabled` and `modelId` are the admin's, so a
   * re-save never touches them — except to switch off one it no longer declares.
   */
  private async writeAgents(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    const rows = await this.prisma.aiAgent.findMany({ where: { workspaceId, blueprintId } });
    let writes = 0;
    const declared = new Set<string>();
    for (const a of blueprint.agents ?? []) {
      const key = ownedAgentKey(a.key, blueprintId);
      declared.add(key);
      const data = { name: a.name, description: a.description ?? null, instructions: a.instructions, tools: a.tools ?? [], minTier: a.minTier ?? null };
      const row = rows.find((r) => r.key === key);
      if (!row) {
        await this.prisma.aiAgent.create({ data: { workspaceId, key, builtIn: false, blueprintId, ...data, createdBy: actorId ?? null } });
        writes += 1;
      } else if (
        row.name !== data.name ||
        row.description !== data.description ||
        row.instructions !== data.instructions ||
        row.minTier !== data.minTier ||
        !same(row.tools, data.tools)
      ) {
        await this.prisma.aiAgent.update({ where: { id: row.id }, data });
        writes += 1;
      }
    }
    for (const row of rows.filter((r) => r.enabled && !declared.has(r.key))) {
      await this.prisma.aiAgent.update({ where: { id: row.id }, data: { enabled: false } });
      writes += 1;
    }
    return writes;
  }

  private async writeGlossary(workspaceId: string, blueprintId: string, blueprint: Blueprint, actorId?: string): Promise<number> {
    const rows = await this.prisma.glossaryTerm.findMany({ where: { workspaceId, projectId: null, blueprintId } });
    // One term per spelling, the scaffold's rule.
    const declared = new Map((blueprint.conventions?.glossary ?? []).map((g) => [g.term.trim().toLowerCase(), g]));
    let writes = 0;
    for (const [key, g] of declared) {
      const data = { definition: g.definition.trim(), aliases: normalizeAliases(g.aliases, g.term) };
      const row = rows.find((r) => r.term.toLowerCase() === key);
      if (!row) {
        await this.prisma.glossaryTerm.create({
          data: { workspaceId, projectId: null, blueprintId, term: g.term.trim(), ...data, createdBy: actorId ?? null },
        });
        writes += 1;
      } else if (row.definition !== data.definition || !same(readAliases(row.aliases), data.aliases) || !row.enabled) {
        await this.prisma.glossaryTerm.update({
          where: { id: row.id },
          data: { ...data, aliases: data.aliases as Prisma.InputJsonValue, enabled: true },
        });
        writes += 1;
      }
    }
    for (const row of rows.filter((r) => r.enabled && !declared.has(r.term.toLowerCase()))) {
      await this.prisma.glossaryTerm.update({ where: { id: row.id }, data: { enabled: false } });
      writes += 1;
    }
    return writes;
  }
}
