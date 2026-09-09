import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { GlossaryTerm as TermRow } from '@prisma/client';
import type {
  GlossaryTerm,
  GlossaryTermSuggestion,
  ListGlossaryResponse,
  SuggestGlossaryTermsResponse,
} from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { ActivityService } from '../activity/activity.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { ProjectsService } from '../projects/projects.service.js';
import { AssistantClient } from '../assistant/assistant.client.js';
import { AiConfigService } from '../ai/ai-config.service.js';
import { AiUsageService } from '../ai/ai-usage.service.js';
import type { Principal } from '../auth/principal.js';
import type {
  CreateGlossaryTermDto,
  ListGlossaryQueryDto,
  SuggestGlossaryTermsDto,
  UpdateGlossaryTermDto,
} from './glossary.dto.js';
import { t } from '../i18n/t.js';

/** How much of a page the extractor sees — the same ceiling `review` uses. */
const MAX_SOURCE_CHARS = 60_000;

/** Ceiling on one extraction run, so a glossary cannot be flooded in one click. */
const MAX_SUGGESTIONS = 25;

/**
 * Glossary (docs/features/14): shared vocabulary, scoped to a project.
 *
 * Workspace > Project > Document, and a term sits at the project level: the
 * same word routinely means different things in two bodies of work, and a
 * glossary that could not say so would be wrong in at least one of them. The
 * workspace stays the ACL boundary — `workspace_id` rides along denormalized,
 * exactly as it does on `documents`.
 *
 * Two layers, deliberately separable — the same split as frontmatter relations
 * versus inferred ones. The **linking** is deterministic and happens on the
 * read side: every rendered page matches its text against the term roster, so
 * a definition edited here updates every page that mentions it and no document
 * is ever rewritten. The **authoring** is where the LLM helps: `suggest` reads
 * a page and drafts the entries it is missing, which a person then accepts.
 *
 * Nothing the model returns is persisted by this service. A suggestion is a
 * proposal; it becomes vocabulary only when someone POSTs it back.
 */
@Injectable()
export class GlossaryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly activity: ActivityService,
    private readonly documents: DocumentsService,
    private readonly projects: ProjectsService,
    private readonly client: AssistantClient,
    private readonly aiConfig: AiConfigService,
    private readonly aiUsage: AiUsageService,
  ) {}

  async list(query: ListGlossaryQueryDto): Promise<ListGlossaryResponse> {
    const search = query.search?.trim();
    const rows = await this.prisma.glossaryTerm.findMany({
      where: {
        workspaceId: query.workspaceId,
        // Absent projectId means the whole workspace — the roster page's view,
        // and the same convention as GET /v1/documents.
        ...(query.projectId ? { projectId: query.projectId } : {}),
        ...(search
          ? {
              OR: [
                { term: { contains: search, mode: 'insensitive' as const } },
                { definition: { contains: search, mode: 'insensitive' as const } },
              ],
            }
          : {}),
      },
      orderBy: { term: 'asc' },
    });
    return {
      workspaceId: query.workspaceId,
      projectId: query.projectId ?? null,
      terms: await this.withDocumentTitles(rows),
    };
  }

  async get(termId: string): Promise<GlossaryTerm> {
    const row = await this.prisma.glossaryTerm.findUnique({ where: { id: termId } });
    if (!row) throw new NotFoundException(t('error.glossary.notFound', { id: termId }));
    return (await this.withDocumentTitles([row]))[0]!;
  }

  async create(dto: CreateGlossaryTermDto, actorId?: string): Promise<GlossaryTerm> {
    const term = dto.term.trim();
    await this.projects.requireProjectInWorkspace(dto.projectId, dto.workspaceId);
    await this.assertNameFree(dto.projectId, term);
    if (dto.documentId) await this.assertDocumentInWorkspace(dto.documentId, dto.workspaceId);

    const row = await this.prisma.glossaryTerm.create({
      data: {
        workspaceId: dto.workspaceId,
        projectId: dto.projectId,
        term,
        definition: dto.definition.trim(),
        aliases: normalizeAliases(dto.aliases, term),
        documentId: dto.documentId ?? null,
        source: dto.source ?? 'manual',
        enabled: dto.enabled ?? true,
        createdBy: actorId ?? null,
      },
    });
    await this.activity.record({
      workspaceId: row.workspaceId,
      actor: actorId,
      action: 'glossary.term.created',
      subjectId: row.id,
      documentId: row.documentId ?? undefined,
      metadata: { term: row.term, source: row.source, projectId: row.projectId },
    });
    return (await this.withDocumentTitles([row]))[0]!;
  }

  async update(termId: string, dto: UpdateGlossaryTermDto, actorId?: string): Promise<GlossaryTerm> {
    const current = await this.prisma.glossaryTerm.findUnique({ where: { id: termId } });
    if (!current) throw new NotFoundException(t('error.glossary.notFound', { id: termId }));

    const term = dto.term?.trim();
    if (term && term.toLowerCase() !== current.term.toLowerCase()) {
      await this.assertNameFree(current.projectId, term);
    }
    if (dto.documentId) await this.assertDocumentInWorkspace(dto.documentId, current.workspaceId);

    const row = await this.prisma.glossaryTerm.update({
      where: { id: termId },
      data: {
        ...(term === undefined ? {} : { term }),
        ...(dto.definition === undefined ? {} : { definition: dto.definition.trim() }),
        ...(dto.aliases === undefined ? {} : { aliases: normalizeAliases(dto.aliases, term ?? current.term) }),
        ...(dto.documentId === undefined ? {} : { documentId: dto.documentId }),
        ...(dto.enabled === undefined ? {} : { enabled: dto.enabled }),
      },
    });
    await this.activity.record({
      workspaceId: row.workspaceId,
      actor: actorId,
      action: 'glossary.term.updated',
      subjectId: row.id,
      documentId: row.documentId ?? undefined,
      metadata: { term: row.term, fields: Object.keys(dto) },
    });
    return (await this.withDocumentTitles([row]))[0]!;
  }

  async remove(termId: string, actorId?: string): Promise<{ deleted: true }> {
    const row = await this.prisma.glossaryTerm.findUnique({ where: { id: termId } });
    if (!row) throw new NotFoundException(t('error.glossary.notFound', { id: termId }));
    await this.prisma.glossaryTerm.delete({ where: { id: termId } });
    await this.activity.record({
      workspaceId: row.workspaceId,
      actor: actorId,
      action: 'glossary.term.deleted',
      subjectId: row.id,
      metadata: { term: row.term },
    });
    return { deleted: true };
  }

  /**
   * Draft the entries a page implies but the glossary does not have yet.
   *
   * The model proposes terms and definitions; the *counting* is done here,
   * against the source text, because "how often does this appear" is a fact
   * about the document and models are bad at it. A proposal whose term never
   * literally appears is dropped — that is the cheapest available check that
   * the extraction stayed grounded in the page rather than in the model's
   * background knowledge.
   */
  async suggest(dto: SuggestGlossaryTermsDto, principal: Principal): Promise<SuggestGlossaryTermsResponse> {
    const { text: source, projectId } = await this.suggestSource(dto);

    // Term extraction is an authoring job, not a conversation, so it routes
    // through the workspace's `review` provider profile like the other
    // background passes over a draft (docs/features/12).
    const config = await this.aiConfig.resolveFor(dto.workspaceId, 'review');
    if (!config.enabled) return { enabled: false, projectId, suggestions: [] };
    await this.aiUsage.assertWithinBudget(dto.workspaceId, principal.userId);

    // "Already defined" is a question about the project the term would land
    // in, not about the workspace: the same word may be defined next door and
    // still be missing here.
    const existing = await this.prisma.glossaryTerm.findMany({
      where: projectId ? { projectId } : { workspaceId: dto.workspaceId },
      select: { id: true, term: true, aliases: true },
    });
    const known = new Map<string, string>();
    for (const row of existing) {
      known.set(row.term.toLowerCase(), row.id);
      for (const alias of readAliases(row.aliases)) known.set(alias.toLowerCase(), row.id);
    }

    const raw = await this.client.chat(
      { config, userId: principal.userId, operation: 'glossary', locale: principal.locale },
      [
        {
          role: 'system',
          content:
            'You build the glossary of a team knowledge base. Read the page and list the domain-specific terms ' +
            'a new reader would need defined: product concepts, internal system and service names, acronyms, ' +
            'and terms this team uses with a narrower meaning than the everyday one. ' +
            'Ignore general programming vocabulary, common English, and anything the page does not actually explain. ' +
            'Respond ONLY with a json object of the shape ' +
            '{"terms": [{"term": string, "aliases": string[], "definition": string}]}. ' +
            'Write each definition as one self-contained sentence, in the language of the page, grounded in what ' +
            `the page says. "term" must appear verbatim in the page. At most ${MAX_SUGGESTIONS} terms.`,
        },
        {
          role: 'user',
          content: `Title: ${dto.title || '(untitled)'}\n\nPage:\n\n${source.slice(0, MAX_SOURCE_CHARS)}`,
        },
      ],
      { json: true },
    );

    const parsed = safeJson(raw);
    const proposals = Array.isArray(parsed?.terms) ? (parsed.terms as Array<Record<string, unknown>>) : [];
    const seen = new Set<string>();
    const suggestions: GlossaryTermSuggestion[] = [];

    for (const proposal of proposals) {
      const term = typeof proposal?.term === 'string' ? proposal.term.trim() : '';
      const definition = typeof proposal?.definition === 'string' ? proposal.definition.trim() : '';
      if (!term || !definition) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;

      const occurrences = countOccurrences(source, term);
      if (occurrences === 0) continue; // ungrounded — the model brought it from elsewhere

      seen.add(key);
      suggestions.push({
        term,
        aliases: normalizeAliases(
          Array.isArray(proposal.aliases) ? proposal.aliases.filter((a): a is string => typeof a === 'string') : [],
          term,
        ),
        definition,
        occurrences,
        existingTermId: known.get(key) ?? null,
      });
      if (suggestions.length >= MAX_SUGGESTIONS) break;
    }

    suggestions.sort((a, b) => b.occurrences - a.occurrences);
    return { enabled: true, projectId, suggestions };
  }

  /**
   * What to read, and which project's glossary the result belongs to.
   *
   * The project is taken from the source page rather than from the caller
   * whenever there is one: a term extracted from a page is vocabulary for that
   * page's project, and letting the client name a different one would make it
   * trivial to file a suggestion in the wrong place.
   */
  private async suggestSource(
    dto: SuggestGlossaryTermsDto,
  ): Promise<{ text: string; projectId: string | null }> {
    if (dto.projectId) await this.projects.requireProjectInWorkspace(dto.projectId, dto.workspaceId);
    if (!dto.documentId) {
      return { text: dto.markdown ?? '', projectId: dto.projectId ?? null };
    }
    // AclGuard authorized dto.workspaceId — make sure the page belongs to it
    // before reading, so a page id from another tenant cannot be summarized.
    const document = await this.assertDocumentInWorkspace(dto.documentId, dto.workspaceId);
    if (dto.markdown?.trim()) return { text: dto.markdown, projectId: document.projectId };
    try {
      const content = await this.documents.getContent(dto.documentId);
      return { text: content.markdown, projectId: document.projectId };
    } catch {
      // Draft-only page: the model gets nothing rather than an error.
      return { text: '', projectId: document.projectId };
    }
  }

  private async assertNameFree(projectId: string, term: string): Promise<void> {
    const clash = await this.prisma.glossaryTerm.findFirst({
      where: { projectId, term: { equals: term, mode: 'insensitive' } },
      select: { id: true },
    });
    if (clash) throw new ConflictException(t('error.glossary.duplicate', { term }));
  }

  private async assertDocumentInWorkspace(
    documentId: string,
    workspaceId: string,
  ): Promise<{ projectId: string }> {
    const doc = await this.prisma.document.findUnique({
      where: { id: documentId },
      select: { workspaceId: true, projectId: true },
    });
    if (!doc || doc.workspaceId !== workspaceId) {
      throw new NotFoundException(t('error.glossary.documentNotFound', { id: documentId }));
    }
    return { projectId: doc.projectId };
  }

  /**
   * Defining pages are a soft link (no FK), so the title is resolved here and
   * a deleted page simply reads as an unlinked term rather than a broken one.
   */
  private async withDocumentTitles(rows: TermRow[]): Promise<GlossaryTerm[]> {
    const ids = [...new Set(rows.map((r) => r.documentId).filter((id): id is string => !!id))];
    const titles = new Map<string, string>();
    if (ids.length) {
      const docs = await this.prisma.document.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true },
      });
      for (const doc of docs) titles.set(doc.id, doc.title);
    }
    return rows.map((row) => ({
      termId: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      term: row.term,
      aliases: readAliases(row.aliases),
      definition: row.definition,
      documentId: row.documentId,
      documentTitle: row.documentId ? (titles.get(row.documentId) ?? null) : null,
      source: row.source === 'ai' ? 'ai' : 'manual',
      enabled: row.enabled,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}

/** `aliases` is Json (the schema uses no Postgres arrays) — read it defensively. */
function readAliases(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Deduplicated, and never containing the term itself: an alias that equals the
 * headword would make the linker match the same text twice.
 */
function normalizeAliases(aliases: string[] | undefined, term: string): string[] {
  const seen = new Set<string>([term.trim().toLowerCase()]);
  const out: string[] = [];
  for (const alias of aliases ?? []) {
    const trimmed = alias.trim();
    const key = trimmed.toLowerCase();
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
    if (out.length >= 20) break;
  }
  return out;
}

/** Whole-word, case-insensitive count — the same shape the read-side linker matches on. */
function countOccurrences(haystack: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \b fails on terms that start or end with punctuation ("C++", ".env"), so
  // the boundaries are spelled out as "not a word character".
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  return (haystack.match(re) ?? []).length;
}

function safeJson(raw: string): Record<string, unknown> | null {
  try {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    return JSON.parse(fenced ? fenced[1]! : raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}
