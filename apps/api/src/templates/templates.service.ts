import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PageTemplate, PageTemplateVersion, Prisma } from '@prisma/client';
import {
  BUILT_IN_TEMPLATE_KEYS,
  FRONTMATTER_KEY_ALIASES,
  builtInTemplateRef,
  isBuiltInTemplateKey,
  missingRequiredPlaceholders,
  parseTemplateRef,
  renderTemplate,
  renderTemplateFrontmatter,
  renderTemplateTitle,
  type BuiltInTemplateKey,
  type DocumentCategory,
  type ListTemplatesResponse,
  type ListTemplateVersionsResponse,
  type Locale,
  type RenderTemplateResponse,
  type TemplateDetail,
  type TemplateMeta,
  type TemplateRef,
  type TemplateSummary,
  type TemplateVersionInfo,
  type TemplateValues,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { composeFrontmatter } from '../common/frontmatter.js';
import {
  readFrontmatterRelations,
  readFrontmatterTags,
  type FrontmatterRelation,
} from '../common/relations.js';
// t.ts's currentLocale honours `withLocale`, so a worker or MCP render answers
// in the language its caller pinned rather than the default.
import { currentLocale, t } from '../i18n/t.js';
import { BUILT_IN_TEMPLATES, type BuiltInTemplate } from './built-in/index.js';
import { parseTemplateSource, TemplateSourceError, type ParsedTemplateSource } from './template-source.js';
import { TEMPLATE_MAX_VALUE_CHARS, TEMPLATES_MAX_PER_WORKSPACE } from './templates.constants.js';

/** A template pinned to one version, parsed — what rendering and provenance need. */
export interface ResolvedTemplate {
  ref: TemplateRef;
  workspaceId: string;
  builtInKey: BuiltInTemplateKey | null;
  version: number;
  name: string;
  source: string;
  parsed: ParsedTemplateSource;
  /** The row, when one exists; null for an untouched built-in. */
  row: PageTemplate | null;
}

export interface CreateTemplateInput {
  workspaceId: string;
  projectId?: string | null;
  builtInKey?: string;
  name?: string;
  description?: string | null;
  icon?: string | null;
  source?: string;
  enabled?: boolean;
}

export interface UpdateTemplateInput {
  name?: string;
  description?: string | null;
  icon?: string | null;
  source?: string;
  enabled?: boolean;
}

export interface RenderTemplateInput {
  workspaceId: string;
  ref: TemplateRef;
  version?: number;
  title?: string;
  values?: TemplateValues;
  projectId?: string;
  parentId?: string;
}

export interface TemplateDefaultsInput {
  workspaceId: string;
  ref: TemplateRef;
  version?: number;
  /** The `{{title}}` system placeholder. */
  title: string;
  projectId?: string;
  parentId?: string;
  authorId?: string;
  /** Refuse an archived template, as `render` does. Off for a workflow pinned to one. */
  live?: boolean;
}

/** What a template contributes to a page whose body somebody else writes. */
export interface TemplateDefaults {
  ref: TemplateRef;
  version: number;
  name: string;
  meta: TemplateMeta;
  /** The body with system placeholders filled and declared ones left as `{{name}}`. */
  skeleton: string;
  /** `titlePattern` with system placeholders filled, when the template has one. */
  titlePattern: string | null;
  tags: string[];
  relations: FrontmatterRelation[];
  /** Inherited frontmatter other than `tags`/`relations` (under any spelling). */
  frontmatter: Record<string, unknown>;
}

type RowWithCount = PageTemplate & { _count: { versions: number } };

/**
 * Page templates (issue #69): the gallery, versions, and rendering.
 *
 * Controller-free and auth-free so the worker can load it (workflow drafts are
 * shaped by a template too). Role checks that depend on a row's scope — a
 * workspace-wide template needs `admin` — are made by the controller, which
 * asks `scopeOf` first.
 *
 * Built-ins are code (`built-in/`), merged with rows at read time. A row whose
 * `builtInKey` is set overrides one: versions of its own, `enabled = false`, or
 * both. Every lookup filters by workspace, so a template id from another
 * tenant is a 404 here even when a caller skipped the guard.
 */
@Injectable()
export class TemplatesService {
  /** Parsed built-in sources, per locale — they are constants, so parse once. */
  private readonly builtInCache = new Map<string, ParsedTemplateSource>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly projects: ProjectsService,
  ) {}

  // ------------------------------------------------------------------- reads

  /**
   * The gallery: rows (project ones first, then workspace-wide), then the
   * built-ins in their fixed order with any override applied. A project
   * filter returns workspace-wide rows plus that project's. Archived rows
   * and hidden built-ins only with `includeArchived` — the settings page needs
   * them to bring one back.
   */
  async list(query: { workspaceId: string; projectId?: string; includeArchived?: boolean }): Promise<ListTemplatesResponse> {
    const locale = currentLocale();
    const rows: RowWithCount[] = await this.prisma.pageTemplate.findMany({
      where: {
        workspaceId: query.workspaceId,
        ...(query.projectId ? { OR: [{ projectId: query.projectId }, { projectId: null }] } : {}),
      },
      include: { _count: { select: { versions: true } } },
      orderBy: [{ name: 'asc' }],
    });

    const custom = rows
      .filter((row) => !row.builtInKey && (query.includeArchived || !row.archivedAt))
      .map((row) => this.customSummary(row))
      .sort((a, b) => Number(b.scope === 'project') - Number(a.scope === 'project'));

    const overrides = new Map(
      rows.filter((row) => row.builtInKey && !row.projectId).map((row) => [row.builtInKey as string, row]),
    );
    const builtIns = BUILT_IN_TEMPLATE_KEYS.map((key) =>
      this.builtInSummary(query.workspaceId, key, overrides.get(key) ?? null, locale),
    ).filter((summary) => query.includeArchived || summary.enabled);

    return { templates: [...custom, ...builtIns] };
  }

  async get(id: string, version?: number): Promise<TemplateDetail> {
    const row = await this.requireRow(id);
    const ref = row.builtInKey ? builtInTemplateRef(row.builtInKey as BuiltInTemplateKey) : row.id;
    return this.detail(await this.resolve(row.workspaceId, ref, version));
  }

  async getBuiltIn(workspaceId: string, key: string, version?: number): Promise<TemplateDetail> {
    if (!isBuiltInTemplateKey(key)) throw new NotFoundException(t('error.template.notFound', { ref: key }));
    return this.detail(await this.resolve(workspaceId, builtInTemplateRef(key), version));
  }

  /** By ref — what MCP and the assistant ask with, since they never hold a row id for a built-in. */
  async getByRef(workspaceId: string, ref: TemplateRef, version?: number): Promise<TemplateDetail> {
    return this.detail(await this.resolve(workspaceId, ref, version));
  }

  /** Newest first. A customised built-in lists the shipped version under its own. */
  async listVersions(id: string): Promise<ListTemplateVersionsResponse> {
    const row = await this.requireRow(id);
    const versions = await this.prisma.pageTemplateVersion.findMany({
      where: { templateId: id },
      select: { version: true, createdBy: true, createdAt: true },
      orderBy: { version: 'desc' },
    });
    const out: TemplateVersionInfo[] = versions.map((v) => ({
      version: v.version,
      createdBy: v.createdBy,
      createdAt: v.createdAt.toISOString(),
      builtIn: false,
    }));
    if (row.builtInKey && isBuiltInTemplateKey(row.builtInKey)) {
      out.push({ version: BUILT_IN_TEMPLATES[row.builtInKey].version, createdBy: null, createdAt: null, builtIn: true });
    }
    return { versions: out };
  }

  /** Who a role check on `:id` routes is about: a workspace-wide row needs `admin` to write. */
  async scopeOf(id: string): Promise<{ workspaceId: string; projectId: string | null; builtInKey: string | null }> {
    const row = await this.requireRow(id);
    return { workspaceId: row.workspaceId, projectId: row.projectId, builtInKey: row.builtInKey };
  }

  /**
   * A template at one version, parsed. Never refuses an archived or hidden
   * template: a page or workflow pinned to it must still be able to say what
   * it was made from. Refusing new pages from an archived one is `render`'s job.
   */
  async resolve(workspaceId: string, ref: TemplateRef, version?: number): Promise<ResolvedTemplate> {
    const parsedRef = parseTemplateRef(ref);
    if (!parsedRef) throw new NotFoundException(t('error.template.notFound', { ref }));
    const missingVersion = (v: number) =>
      new NotFoundException(t('error.template.versionNotFound', { ref, version: v }));

    if (parsedRef.kind === 'builtin') {
      const builtIn = BUILT_IN_TEMPLATES[parsedRef.key];
      const canonical = builtInTemplateRef(parsedRef.key);
      const row = await this.prisma.pageTemplate.findFirst({
        where: { workspaceId, builtInKey: parsedRef.key, projectId: null },
      });
      const locale = currentLocale();
      const shipped = (): ResolvedTemplate => ({
        ref: canonical,
        workspaceId,
        builtInKey: parsedRef.key,
        version: builtIn.version,
        name: row?.name || builtIn.text[locale].name,
        source: builtIn.text[locale].source,
        parsed: this.parsedBuiltIn(builtIn, locale),
        row,
      });
      if (!row) {
        if (version !== undefined && version !== builtIn.version) throw missingVersion(version);
        return shipped();
      }
      const want = version ?? row.currentVersion;
      const stored = await this.prisma.pageTemplateVersion.findUnique({
        where: { templateId_version: { templateId: row.id, version: want } },
      });
      if (stored) return this.fromVersion(canonical, parsedRef.key, row, stored, row.name || builtIn.text[locale].name);
      if (want === builtIn.version) return shipped();
      throw missingVersion(want);
    }

    const row = await this.prisma.pageTemplate.findFirst({ where: { id: parsedRef.id, workspaceId } });
    if (!row || row.builtInKey) throw new NotFoundException(t('error.template.notFound', { ref }));
    const want = version ?? row.currentVersion;
    const stored = await this.prisma.pageTemplateVersion.findUnique({
      where: { templateId_version: { templateId: row.id, version: want } },
    });
    if (!stored) throw missingVersion(want);
    return this.fromVersion(row.id, null, row, stored, row.name);
  }

  // ------------------------------------------------------------------ render

  /**
   * Fill a template in: the title pattern, the body and the inherited
   * frontmatter. No write. `user`/`page` values are resolved inside the
   * workspace here, so an id from another tenant renders as a missing value
   * rather than leaking a name.
   */
  async render(input: RenderTemplateInput, author?: { id: string; name?: string }): Promise<RenderTemplateResponse> {
    const template = await this.resolve(input.workspaceId, input.ref, input.version);
    if (template.row?.archivedAt) throw new ConflictException(t('error.template.archived', { name: template.name }));
    const { meta } = template.parsed;

    const values = this.cleanValues(input.values);
    const ids = (kind: 'user' | 'page') =>
      meta.placeholders.filter((p) => p.kind === kind).map((p) => values[p.name]).filter((v): v is string => !!v);
    const [users, pages, project, parent, authorName] = await Promise.all([
      this.memberLabels(input.workspaceId, ids('user')),
      this.pageLabels(input.workspaceId, ids('page')),
      input.projectId ? this.projects.requireProjectInWorkspace(input.projectId, input.workspaceId) : null,
      input.parentId
        ? this.prisma.document.findFirst({
            where: { id: input.parentId, workspaceId: input.workspaceId },
            select: { title: true },
          })
        : null,
      author?.name ?? (author ? this.displayName(author.id) : undefined),
    ]);
    const labels = { ...users, ...pages };

    const missing = [
      ...new Set([
        ...missingRequiredPlaceholders(meta, values),
        // An id that resolved to nothing is as good as blank.
        ...meta.placeholders
          .filter((p) => p.required && (p.kind === 'user' || p.kind === 'page') && values[p.name] && !labels[values[p.name]])
          .map((p) => p.name),
      ]),
    ];
    if (missing.length > 0) {
      throw new BadRequestException({
        statusCode: 400,
        message: t('error.template.placeholderMissing', { names: missing.join(', ') }),
        missing,
      });
    }

    const ctx = {
      locale: currentLocale(),
      title: input.title?.trim() || template.name,
      author: authorName ?? '',
      project: project?.name ?? '',
      parent: parent?.title ?? '',
      labels,
    };
    const body = renderTemplate(template.parsed.body, meta, values, ctx);
    const frontmatter = renderTemplateFrontmatter(template.parsed.data, meta, values, ctx);
    return {
      templateRef: template.ref,
      templateVersion: template.version,
      title: renderTemplateTitle(meta, values, ctx),
      category: meta.category,
      frontmatter,
      body,
      markdown: composeFrontmatter(body, frontmatter),
    };
  }

  /**
   * A template for a writer that has no placeholder values: a workflow's
   * `ai.draft` model, or an import whose body already exists. System
   * placeholders are filled; declared ones stay `{{name}}` in the skeleton for
   * the model to fill from its source. A default tag or relation that needs a
   * declared value is dropped (`renderTemplateFrontmatter`), never written as an
   * empty key — so what survives is only what is true of every page made from
   * the template.
   */
  async defaults(input: TemplateDefaultsInput): Promise<TemplateDefaults> {
    const template = await this.resolve(input.workspaceId, input.ref, input.version);
    if (input.live && template.row?.archivedAt) {
      throw new ConflictException(t('error.template.archived', { name: template.name }));
    }
    const { meta } = template.parsed;
    const [project, parent, authorName] = await Promise.all([
      input.projectId ? this.projects.requireProjectInWorkspace(input.projectId, input.workspaceId) : null,
      input.parentId
        ? this.prisma.document.findFirst({
            where: { id: input.parentId, workspaceId: input.workspaceId },
            select: { title: true },
          })
        : null,
      input.authorId ? this.displayName(input.authorId) : undefined,
    ]);
    const ctx = {
      locale: currentLocale(),
      title: input.title.trim() || template.name,
      author: authorName ?? '',
      project: project?.name ?? '',
      parent: parent?.title ?? '',
    };
    // With no declarations, `renderTemplate` fills only system names and leaves
    // every declared `{{name}}` literal — the skeleton a model fills in.
    const systemOnly: TemplateMeta = { ...meta, placeholders: [] };
    const rendered = renderTemplateFrontmatter(template.parsed.data, meta, {}, ctx);
    const frontmatter = Object.fromEntries(
      Object.entries(rendered).filter(([key]) => {
        const folded = key.normalize('NFC').trim().toLowerCase();
        return folded !== 'tags' && folded !== 'relations' && FRONTMATTER_KEY_ALIASES[folded] === undefined;
      }),
    );
    return {
      ref: template.ref,
      version: template.version,
      name: template.name,
      meta,
      skeleton: renderTemplate(template.parsed.body, systemOnly, {}, ctx),
      titlePattern: meta.titlePattern?.trim() ? renderTemplateTitle(systemOnly, {}, ctx) : null,
      tags: readFrontmatterTags(rendered),
      relations: readFrontmatterRelations(rendered),
      frontmatter,
    };
  }

  // ------------------------------------------------------------------ writes

  async create(input: CreateTemplateInput, userId?: string): Promise<TemplateDetail> {
    const total = await this.prisma.pageTemplate.count({ where: { workspaceId: input.workspaceId } });
    if (total >= TEMPLATES_MAX_PER_WORKSPACE) {
      throw new ConflictException(t('error.template.limitReached', { max: TEMPLATES_MAX_PER_WORKSPACE }));
    }

    if (input.builtInKey !== undefined) return this.createOverride(input, userId);

    if (input.projectId) await this.projects.requireProjectInWorkspace(input.projectId, input.workspaceId);
    const name = input.name?.trim();
    if (!name) throw new BadRequestException(t('error.template.nameRequired'));
    if (!input.source) throw new BadRequestException(t('error.template.sourceRequired'));
    const parsed = this.parseOrThrow(input.source);
    await this.assertNameFree(input.workspaceId, input.projectId ?? null, name);

    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.pageTemplate.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: input.projectId ?? null,
          name,
          description: input.description ?? parsed.meta.description ?? null,
          icon: input.icon ?? null,
          category: parsed.meta.category,
          currentVersion: 1,
          enabled: input.enabled ?? true,
          createdBy: userId ?? null,
        },
      });
      await tx.pageTemplateVersion.create({
        data: { templateId: created.id, version: 1, source: input.source!, meta: this.metaJson(parsed.meta), createdBy: userId ?? null },
      });
      return created;
    });
    this.record(row, 'template.created', userId);
    return this.get(row.id);
  }

  /**
   * A source change appends an immutable version and bumps `currentVersion`
   * in one transaction; a name, icon or `enabled` change does not version —
   * the version answers "which shape", and a rename is not a new shape. A
   * source identical to the current one is not a change either.
   */
  async update(id: string, input: UpdateTemplateInput, userId?: string): Promise<TemplateDetail> {
    const row = await this.requireRow(id);
    const name = input.name?.trim();
    if (input.name !== undefined && !name && !row.builtInKey) throw new BadRequestException(t('error.template.nameRequired'));
    if (name && name !== row.name && !row.builtInKey) await this.assertNameFree(row.workspaceId, row.projectId, name, row.id);

    let nextVersion: { version: number; source: string; meta: TemplateMeta } | null = null;
    if (input.source !== undefined) {
      const parsed = this.parseOrThrow(input.source);
      const current = await this.prisma.pageTemplateVersion.findUnique({
        where: { templateId_version: { templateId: row.id, version: row.currentVersion } },
        select: { source: true },
      });
      if (current?.source !== input.source) {
        // A built-in override's own versions continue from the shipped one, so
        // its history reads as one line: shipped v1, then the workspace's v2…
        const base = current ? row.currentVersion : this.builtInVersion(row);
        nextVersion = { version: base + 1, source: input.source, meta: parsed.meta };
      }
    }

    const data: Prisma.PageTemplateUpdateInput = {
      ...(input.name !== undefined ? { name: name ?? '' } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(nextVersion ? { currentVersion: nextVersion.version, category: nextVersion.meta.category } : {}),
    };
    if (Object.keys(data).length === 0) return this.get(id);

    const updated = await this.prisma.$transaction(async (tx) => {
      if (nextVersion) {
        await tx.pageTemplateVersion.create({
          data: {
            templateId: row.id,
            version: nextVersion.version,
            source: nextVersion.source,
            meta: this.metaJson(nextVersion.meta),
            createdBy: userId ?? null,
          },
        });
      }
      return tx.pageTemplate.update({ where: { id: row.id }, data });
    });
    this.record(updated, 'template.updated', userId, nextVersion ? { version: nextVersion.version } : {});
    return this.get(id);
  }

  /** Soft. Custom templates only: a built-in is hidden (`enabled = false`), not archived. */
  async setArchived(id: string, archived: boolean, userId?: string): Promise<TemplateDetail> {
    const row = await this.requireRow(id);
    if (row.builtInKey) throw new BadRequestException(t('error.template.builtInNotArchivable'));
    if (Boolean(row.archivedAt) !== archived) {
      const updated = await this.prisma.pageTemplate.update({
        where: { id },
        data: { archivedAt: archived ? new Date() : null },
      });
      this.record(updated, archived ? 'template.archived' : 'template.unarchived', userId);
    }
    return this.get(id);
  }

  /**
   * Reset a built-in to its shipped default by deleting the workspace's
   * override (versions cascade). A custom template is never hard-deleted —
   * pages record it as their provenance — so it is archived instead.
   */
  async remove(id: string, userId?: string): Promise<void> {
    const row = await this.requireRow(id);
    if (!row.builtInKey) throw new BadRequestException(t('error.template.notDeletable'));
    await this.prisma.pageTemplate.delete({ where: { id } });
    this.record(row, 'template.reset', userId);
  }

  // ----------------------------------------------------------------- helpers

  private async createOverride(input: CreateTemplateInput, userId?: string): Promise<TemplateDetail> {
    const key = input.builtInKey ?? '';
    if (!isBuiltInTemplateKey(key)) throw new NotFoundException(t('error.template.notFound', { ref: key }));
    if (input.projectId) throw new BadRequestException(t('error.template.builtInWorkspaceOnly'));
    // App-side uniqueness (one override per built-in per workspace). A race
    // can still insert two; `resolve` reads the first, and reset deletes it,
    // after which the second takes over — it self-corrects on the next reset.
    const existing = await this.prisma.pageTemplate.findFirst({
      where: { workspaceId: input.workspaceId, builtInKey: key, projectId: null },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        statusCode: 409,
        message: t('error.template.alreadyCustomized'),
        templateId: existing.id,
      });
    }
    const builtIn = BUILT_IN_TEMPLATES[key];
    const parsed = input.source ? this.parseOrThrow(input.source) : null;
    const row = await this.prisma.$transaction(async (tx) => {
      const created = await tx.pageTemplate.create({
        data: {
          workspaceId: input.workspaceId,
          projectId: null,
          builtInKey: key,
          // Empty = inherit the built-in's localized name, which a stored copy would freeze in one language.
          name: input.name?.trim() ?? '',
          description: input.description ?? null,
          icon: input.icon ?? null,
          category: parsed?.meta.category ?? this.parsedBuiltIn(builtIn, 'en').meta.category,
          currentVersion: parsed ? builtIn.version + 1 : builtIn.version,
          enabled: input.enabled ?? true,
          createdBy: userId ?? null,
        },
      });
      if (parsed) {
        await tx.pageTemplateVersion.create({
          data: {
            templateId: created.id,
            version: builtIn.version + 1,
            source: input.source!,
            meta: this.metaJson(parsed.meta),
            createdBy: userId ?? null,
          },
        });
      }
      return created;
    });
    this.record(row, 'template.created', userId);
    return this.get(row.id);
  }

  private async requireRow(id: string): Promise<PageTemplate> {
    const row = await this.prisma.pageTemplate.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(t('error.template.notFound', { ref: id }));
    return row;
  }

  private builtInVersion(row: PageTemplate): number {
    return row.builtInKey && isBuiltInTemplateKey(row.builtInKey) ? BUILT_IN_TEMPLATES[row.builtInKey].version : 0;
  }

  /** Names are unique per (workspace, project) among custom templates, archived ones included. */
  private async assertNameFree(workspaceId: string, projectId: string | null, name: string, exceptId?: string): Promise<void> {
    const clash = await this.prisma.pageTemplate.findFirst({
      where: {
        workspaceId,
        projectId,
        builtInKey: null,
        name: { equals: name, mode: 'insensitive' },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (clash) throw new ConflictException(t('error.template.nameTaken', { name }));
  }

  private parseOrThrow(source: string): ParsedTemplateSource {
    try {
      return parseTemplateSource(source);
    } catch (e) {
      if (e instanceof TemplateSourceError) {
        throw new BadRequestException({
          statusCode: 400,
          message: t(`error.template.source.${e.code}`, { detail: e.detail }),
          code: e.code,
          detail: e.detail,
        });
      }
      throw e;
    }
  }

  private parsedBuiltIn(builtIn: BuiltInTemplate, locale: Locale): ParsedTemplateSource {
    const cacheKey = `${builtIn.key}:${locale}`;
    let parsed = this.builtInCache.get(cacheKey);
    if (!parsed) {
      parsed = parseTemplateSource(builtIn.text[locale].source);
      this.builtInCache.set(cacheKey, parsed);
    }
    return parsed;
  }

  private fromVersion(
    ref: TemplateRef,
    builtInKey: BuiltInTemplateKey | null,
    row: PageTemplate,
    stored: PageTemplateVersion,
    name: string,
  ): ResolvedTemplate {
    // Re-parsed rather than read from `meta`: the stored source is the truth,
    // and a version written before a parser fix should render with the fix.
    // Parsing cannot fail — it was validated on write.
    return {
      ref,
      workspaceId: row.workspaceId,
      builtInKey,
      version: stored.version,
      name,
      source: stored.source,
      parsed: parseTemplateSource(stored.source),
      row,
    };
  }

  private metaJson(meta: TemplateMeta): Prisma.InputJsonValue {
    return meta as unknown as Prisma.InputJsonValue;
  }

  private cleanValues(values: TemplateValues | undefined): TemplateValues {
    const out: TemplateValues = {};
    for (const [name, value] of Object.entries(values ?? {})) {
      if (typeof value !== 'string') continue;
      if (value.length > TEMPLATE_MAX_VALUE_CHARS) {
        throw new BadRequestException(t('error.template.valueTooLong', { name, max: TEMPLATE_MAX_VALUE_CHARS }));
      }
      out[name] = value.trim();
    }
    return out;
  }

  /** Display names of workspace members only — a user outside the workspace has no name here. */
  private async memberLabels(workspaceId: string, ids: string[]): Promise<Record<string, string>> {
    const valid = ids.filter((id) => parseTemplateRef(id)?.kind === 'custom');
    if (valid.length === 0) return {};
    const members = await this.prisma.workspaceMember.findMany({
      where: { workspaceId, userId: { in: valid } },
      select: { userId: true, user: { select: { displayName: true, email: true } } },
    });
    return Object.fromEntries(members.map((m) => [m.userId, m.user.displayName || m.user.email]));
  }

  private async pageLabels(workspaceId: string, ids: string[]): Promise<Record<string, string>> {
    const valid = ids.filter((id) => parseTemplateRef(id)?.kind === 'custom');
    if (valid.length === 0) return {};
    const pages = await this.prisma.document.findMany({
      where: { workspaceId, id: { in: valid } },
      select: { id: true, title: true },
    });
    return Object.fromEntries(pages.map((p) => [p.id, p.title]));
  }

  private async displayName(userId: string): Promise<string | undefined> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { displayName: true } });
    return user?.displayName ?? undefined;
  }

  private customSummary(row: PageTemplate): TemplateSummary {
    return {
      ref: row.id,
      id: row.id,
      builtInKey: null,
      scope: row.projectId ? 'project' : 'workspace',
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      name: row.name,
      description: row.description,
      icon: row.icon,
      category: row.category as DocumentCategory,
      currentVersion: row.currentVersion,
      enabled: row.enabled,
      customized: false,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private builtInSummary(
    workspaceId: string,
    key: BuiltInTemplateKey,
    row: (PageTemplate & { _count?: { versions: number } }) | null,
    locale: Locale,
  ): TemplateSummary {
    const builtIn = BUILT_IN_TEMPLATES[key];
    const text = builtIn.text[locale];
    const customized = (row?._count?.versions ?? 0) > 0;
    return {
      ref: builtInTemplateRef(key),
      id: row?.id ?? null,
      builtInKey: key,
      scope: 'built-in',
      workspaceId,
      projectId: null,
      name: row?.name || text.name,
      description: row?.description ?? text.description,
      icon: row?.icon ?? builtIn.icon,
      category: customized ? (row!.category as DocumentCategory) : this.parsedBuiltIn(builtIn, locale).meta.category,
      currentVersion: customized ? row!.currentVersion : builtIn.version,
      enabled: row?.enabled ?? true,
      customized,
      archivedAt: null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    };
  }

  private async detail(template: ResolvedTemplate): Promise<TemplateDetail> {
    const row = template.row;
    let summary: TemplateSummary;
    if (template.builtInKey) {
      const count = row ? await this.prisma.pageTemplateVersion.count({ where: { templateId: row.id } }) : 0;
      summary = this.builtInSummary(
        template.workspaceId,
        template.builtInKey,
        row ? { ...row, _count: { versions: count } } : null,
        currentLocale(),
      );
    } else {
      summary = this.customSummary(row!);
    }
    return {
      ...summary,
      // The shipped source's `meta.description` is not the gallery text; the
      // name a version renders under is what the resolve said it was.
      name: template.name,
      category: template.parsed.meta.category,
      source: template.source,
      meta: template.parsed.meta,
      body: template.parsed.body,
      tags: template.parsed.tags,
      relations: template.parsed.relations,
      frontmatter: template.parsed.data,
      version: template.version,
    };
  }

  private record(row: PageTemplate, action: string, userId?: string, extra: Record<string, unknown> = {}): void {
    void this.activity.record({
      workspaceId: row.workspaceId,
      actor: userId,
      action,
      subjectId: row.id,
      ...(row.projectId ? { projectId: row.projectId } : {}),
      metadata: { title: row.name || row.builtInKey || '', builtInKey: row.builtInKey, ...extra },
    });
  }
}
