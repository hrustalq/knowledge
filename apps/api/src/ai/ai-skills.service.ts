import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiSkill } from '@prisma/client';
import {
  AI_SKILL_INSTRUCTIONS_MAX,
  type AiSkillSummary,
  type GetStyleguideResponse,
  type StyleRule,
  type StyleguideSummary,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { readStyleRules } from '../agents/lint.js';
import type { Env } from '../config/env.js';
import { t } from '../i18n/t.js';

/** Skills merged into one turn, and the total instruction budget they share. */
const MAX_SKILLS_PER_TURN = 3;
const MAX_SKILL_CHARS = AI_SKILL_INSTRUCTIONS_MAX;

/** How long the enabled-skill roster is reused before PG is consulted again. */
const CACHE_TTL_MS = 30_000;

export interface UpsertStyleguideInput {
  /** Null = the workspace's styleguide. */
  projectId: string | null;
  name: string;
  description: string;
  rules: StyleRule[];
}

/** The styleguide that applies to a page, and where it came from. */
export interface EffectiveStyleguide {
  row: AiSkill;
  rules: StyleRule[];
  scope: 'project' | 'workspace';
}

export interface UpsertSkillInput {
  name: string;
  description: string;
  instructions: string;
  triggers?: string[];
  enabled?: boolean;
}

/**
 * Skills (docs/features/12): operator-authored instruction packs that teach
 * the assistant house rules — "always group release notes by Added/Changed/
 * Fixed", "cite the MR id" — without a code change or a redeploy.
 *
 * A skill joins a turn either because the user picked it in the composer or
 * because one of its trigger words appears in their message. Unlike document
 * content, skill text is TRUSTED: it is written by workspace admins, in the
 * same position as the system prompt itself, so the prompt says so explicitly
 * rather than leaving the model to guess how much authority it carries.
 */
@Injectable()
export class AiSkillsService {
  private readonly cache = new Map<string, { at: number; skills: AiSkill[] }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly env: ConfigService<Env, true>,
  ) {}

  async list(workspaceId: string): Promise<AiSkillSummary[]> {
    const skills = await this.prisma.aiSkill.findMany({
      where: { workspaceId, kind: 'skill' },
      orderBy: [{ enabled: 'desc' }, { name: 'asc' }],
    });
    const names = await this.connectorNames(skills);
    return skills.map((s) => toSummary(s, names));
  }

  async get(id: string): Promise<AiSkillSummary> {
    const skill = await this.findSkill(id);
    return toSummary(skill, await this.connectorNames([skill]));
  }

  /**
   * A skill by id — never a styleguide. The skill routes share the table and
   * the `ai-skill` ACL source with the styleguide routes, so without this a
   * PATCH /skills/:id could rewrite a styleguide row as a skill.
   */
  private async findSkill(id: string): Promise<AiSkill> {
    const skill = await this.prisma.aiSkill.findUnique({ where: { id } });
    if (!skill || skill.kind === 'styleguide') throw new NotFoundException(t('error.ai.skillNotFound', { id }));
    return skill;
  }

  /**
   * Promote an imported skill's upstream text to its live instructions (#70).
   * The one way a commit's change reaches an enabled skill: an admin read the
   * diff and pressed Accept. Guarded on the pending text still being there, so
   * a second press (or a sync that settled it meanwhile) is a 409, not a no-op
   * that pretends to have accepted something.
   */
  async acceptUpstream(id: string): Promise<AiSkillSummary> {
    const skill = await this.findSkill(id);
    const pending = skill.pendingInstructions;
    if (pending === null) throw new ConflictException(t('error.ai.skillNoUpstream', { id }));
    const { count } = await this.prisma.aiSkill.updateMany({
      where: { id, pendingInstructions: pending },
      data: { instructions: pending, pendingInstructions: null },
    });
    if (count === 0) throw new ConflictException(t('error.ai.skillNoUpstream', { id }));
    this.cache.delete(skill.workspaceId);
    return this.get(id);
  }

  /** Forget a workspace's cached roster — for writers outside this service (the repo import). */
  invalidate(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }

  async create(workspaceId: string, input: UpsertSkillInput, actorId?: string): Promise<AiSkillSummary> {
    const existing = await this.prisma.aiSkill.findUnique({
      where: { workspaceId_name: { workspaceId, name: input.name } },
    });
    if (existing) throw new ConflictException(t('error.ai.skillNameTaken', { name: input.name }));

    const skill = await this.prisma.aiSkill.create({
      data: {
        workspaceId,
        name: input.name,
        description: input.description,
        instructions: input.instructions,
        triggers: normalizeTriggers(input.triggers),
        enabled: input.enabled ?? true,
        createdBy: actorId ?? null,
      },
    });
    this.cache.delete(workspaceId);
    return toSummary(skill, new Map());
  }

  async update(id: string, input: Partial<UpsertSkillInput>): Promise<AiSkillSummary> {
    const current = await this.findSkill(id);

    if (input.name && input.name !== current.name) {
      const clash = await this.prisma.aiSkill.findUnique({
        where: { workspaceId_name: { workspaceId: current.workspaceId, name: input.name } },
      });
      if (clash) throw new ConflictException(t('error.ai.skillNameTaken', { name: input.name }));
    }

    const skill = await this.prisma.aiSkill.update({
      where: { id },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
        ...(input.triggers === undefined ? {} : { triggers: normalizeTriggers(input.triggers) }),
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      },
    });
    this.cache.delete(current.workspaceId);
    return toSummary(skill, await this.connectorNames([skill]));
  }

  async remove(id: string): Promise<void> {
    const skill = await this.findSkill(id);
    await this.prisma.aiSkill.delete({ where: { id } });
    this.cache.delete(skill.workspaceId);
  }

  // ---- Styleguides (#74) ---------------------------------------------------

  /**
   * The styleguide that applies to a page of `projectId`: the project's own
   * when it has one, else the workspace's. The project row REPLACES the
   * workspace row rather than merging with it, so a project can relax a rule.
   * Both reads carry `workspaceId`, so a foreign project id finds nothing.
   */
  async effectiveStyleguide(workspaceId: string, projectId?: string | null): Promise<EffectiveStyleguide | null> {
    const rows = await this.prisma.aiSkill.findMany({
      where: {
        workspaceId,
        kind: 'styleguide',
        OR: [{ projectId: null }, ...(projectId ? [{ projectId }] : [])],
      },
    });
    const own = projectId ? rows.find((r) => r.projectId === projectId) : undefined;
    const row = own ?? rows.find((r) => r.projectId === null);
    if (!row) return null;
    return { row, rules: readStyleRules(row.rules), scope: own ? 'project' : 'workspace' };
  }

  async getStyleguide(workspaceId: string, projectId?: string | null): Promise<GetStyleguideResponse> {
    const found = await this.effectiveStyleguide(workspaceId, projectId);
    return {
      styleguide: found ? toStyleguide(found.row) : null,
      scope: found?.scope ?? null,
      maxRules: this.env.get('STYLEGUIDE_MAX_RULES', { infer: true }),
    };
  }

  /**
   * Create or replace the styleguide of one scope. One per scope: the guarded
   * `updateMany` of the scope's row comes first and an insert follows only
   * when it touched nothing; the partial unique index in the migration is the
   * backstop for two first saves racing.
   */
  async upsertStyleguide(workspaceId: string, input: UpsertStyleguideInput, actorId?: string): Promise<StyleguideSummary> {
    const max = this.env.get('STYLEGUIDE_MAX_RULES', { infer: true });
    if (input.rules.length > max) {
      throw new BadRequestException(t('error.styleguide.tooManyRules', { max }));
    }
    const ids = new Set<string>();
    for (const rule of input.rules) {
      if (ids.has(rule.id)) throw new BadRequestException(t('error.styleguide.duplicateRuleId', { id: rule.id }));
      ids.add(rule.id);
    }
    if (input.projectId) {
      const project = await this.prisma.project.findFirst({ where: { id: input.projectId, workspaceId }, select: { id: true } });
      if (!project) throw new NotFoundException(t('error.project.notInWorkspace', { id: input.projectId }));
    }

    const scope = { workspaceId, kind: 'styleguide', projectId: input.projectId };
    // A name is unique per workspace across skills and styleguides alike.
    const clash = await this.prisma.aiSkill.findUnique({
      where: { workspaceId_name: { workspaceId, name: input.name } },
    });
    if (clash && !(clash.kind === 'styleguide' && clash.projectId === input.projectId)) {
      throw new ConflictException(t('error.ai.skillNameTaken', { name: input.name }));
    }

    const data = {
      name: input.name,
      description: input.description,
      rules: input.rules.map(cleanRule) as unknown as object,
    };
    const { count } = await this.prisma.aiSkill.updateMany({ where: scope, data });
    if (count === 0) {
      try {
        await this.prisma.aiSkill.create({
          data: { ...scope, ...data, instructions: '', triggers: [], enabled: true, createdBy: actorId ?? null },
        });
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') {
          throw new ConflictException(t('error.styleguide.scopeTaken'));
        }
        throw e;
      }
    }
    const row = await this.prisma.aiSkill.findFirstOrThrow({ where: scope });
    return toStyleguide(row);
  }

  /** The styleguide by id — never a skill — for the delete route's activity line. */
  async getStyleguideById(id: string): Promise<StyleguideSummary> {
    const row = await this.prisma.aiSkill.findUnique({ where: { id } });
    if (!row || row.kind !== 'styleguide') throw new NotFoundException(t('error.styleguide.notFound', { id }));
    return toStyleguide(row);
  }

  async removeStyleguide(id: string): Promise<void> {
    await this.getStyleguideById(id);
    await this.prisma.aiSkill.delete({ where: { id } });
  }

  /**
   * The skills that apply to one turn: explicit picks first (the user asked
   * for them, so they win the budget), then trigger matches against the
   * message. Capped by both count and characters — an unbounded set of skills
   * would quietly eat the context window that documents need.
   */
  async forTurn(workspaceId: string, message: string, skillIds?: string[]): Promise<AiSkill[]> {
    const enabled = await this.enabledSkills(workspaceId);
    if (enabled.length === 0) return [];

    const picked = new Set(skillIds ?? []);
    const explicit = enabled.filter((s) => picked.has(s.id));
    const haystack = message.toLowerCase();
    const triggered = enabled.filter((s) => !picked.has(s.id) && matchesTrigger(s, haystack));

    const chosen: AiSkill[] = [];
    let chars = 0;
    for (const skill of [...explicit, ...triggered]) {
      if (chosen.length >= MAX_SKILLS_PER_TURN) break;
      if (chars + skill.instructions.length > MAX_SKILL_CHARS) continue;
      chars += skill.instructions.length;
      chosen.push(skill);
    }
    return chosen;
  }

  /**
   * The `<skills>` block appended to the system prompt. Empty string when no
   * skill applies, so callers can concatenate unconditionally.
   */
  renderPrompt(skills: AiSkill[]): string {
    if (skills.length === 0) return '';
    const blocks = skills
      .map(
        (s) =>
          `<skill name=${JSON.stringify(s.name)}>\n${s.description ? `${s.description}\n\n` : ''}${s.instructions}\n</skill>`,
      )
      .join('\n\n');
    return (
      '\n\nThe workspace administrators configured the following skills for this turn. Unlike document ' +
      'content, these are INSTRUCTIONS addressed to you and you should follow them, treating them as an ' +
      'extension of the rules above. Where a skill conflicts with a rule above, the rule above wins — a ' +
      `skill can shape how you answer, never widen what you are allowed to access.\n\n${blocks}`
    );
  }

  /** The names of the connectors imported skills came from — one read for a whole roster. */
  private async connectorNames(skills: AiSkill[]): Promise<Map<string, string>> {
    const ids = [...new Set(skills.map((s) => s.sourceConnectorId).filter((id): id is string => id !== null))];
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.connector.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  private async enabledSkills(workspaceId: string): Promise<AiSkill[]> {
    const hit = this.cache.get(workspaceId);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.skills;
    const skills = await this.prisma.aiSkill.findMany({
      where: { workspaceId, kind: 'skill', enabled: true },
      orderBy: { name: 'asc' },
    });
    this.cache.set(workspaceId, { at: Date.now(), skills });
    return skills;
  }
}

/**
 * Whole-word-ish match so "release" does not fire on "released-by-accident".
 * The boundary test is `\p{L}\p{N}`, not `[a-z0-9]`: under the ASCII class a
 * Cyrillic neighbour read as a boundary, so «релиз» fired inside «релизный».
 */
function matchesTrigger(skill: AiSkill, haystack: string): boolean {
  for (const trigger of readTriggers(skill.triggers)) {
    const t = trigger.toLowerCase();
    if (!t) continue;
    const at = haystack.indexOf(t);
    if (at === -1) continue;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + t.length] ?? '';
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

/** `triggers` is Json (the schema uses no Postgres arrays) — read it defensively. */
function readTriggers(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((t): t is string => typeof t === 'string') : [];
}

function normalizeTriggers(triggers: string[] | undefined): string[] {
  return [...new Set((triggers ?? []).map((t) => t.trim()).filter(Boolean))].slice(0, 20);
}

function toSummary(skill: AiSkill, connectorNames: ReadonlyMap<string, string>): AiSkillSummary {
  return {
    id: skill.id,
    workspaceId: skill.workspaceId,
    name: skill.name,
    description: skill.description,
    instructions: skill.instructions,
    triggers: readTriggers(skill.triggers),
    enabled: skill.enabled,
    createdBy: skill.createdBy,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
    source: skill.source === 'repo' ? 'repo' : 'manual',
    sourceConnectorId: skill.sourceConnectorId,
    sourceConnectorName: skill.sourceConnectorId ? (connectorNames.get(skill.sourceConnectorId) ?? null) : null,
    sourcePath: skill.sourcePath,
    sourceSha: skill.sourceSha,
    pendingInstructions: skill.pendingInstructions,
    sourceRemovedAt: skill.sourceRemovedAt?.toISOString() ?? null,
  };
}

function toStyleguide(row: AiSkill): StyleguideSummary {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    name: row.name,
    description: row.description,
    rules: readStyleRules(row.rules),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Exactly the contract's fields, trimmed — a DTO instance carries nothing else into the Json. */
function cleanRule(rule: StyleRule): StyleRule {
  const example =
    rule.example && (rule.example.bad.trim() || rule.example.good.trim())
      ? { bad: rule.example.bad.trim(), good: rule.example.good.trim() }
      : undefined;
  return {
    id: rule.id,
    text: rule.text.trim(),
    severity: rule.severity,
    enabled: rule.enabled,
    ...(example ? { example } : {}),
  };
}
