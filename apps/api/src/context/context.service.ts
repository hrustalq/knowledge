import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CONTEXT_BUDGET,
  CONTEXT_EXCERPT_CHARS,
  CONTEXT_LIMITS,
  effectiveGlossary,
  type ContextPage,
  type ContextRequest,
  type ContextResponse,
  type ContextTerm,
  termPattern,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SearchService } from '../search/search.service.js';
import { MemoryRuntimeService } from '../memory/memory-runtime.service.js';
import { AnalyticsRecorder, type AnalyticsCaller } from '../analytics/analytics.recorder.js';
import { canSeeProject, type AccessScope } from '../permissions/access-scope.js';
import { repositorySegments } from '../components/component-match.js';
import { estimateTokens } from '../ai/ai-usage.service.js';
import { pageText } from '../common/page-text.js';
import { readAliases } from '../glossary/glossary.service.js';
import { projectScope } from '../projects/methodology-scope.js';

/** The MCP tool's name: the answer is measured as that tool renders it. */
export const CONTEXT_TOOL = 'knowledge_context';
/** Connector kinds whose `repoUrl` says a repository belongs to a project. */
const REPO_KINDS = ['codebase', 'markdown-git'];

/**
 * Ticket context (#1193): what the workspace already knows about a ticket, as
 * pointers inside a hard budget. One embedding (the search's) plus SQL, no
 * model call. Push a map, pull the territory: anything deeper is one existing
 * tool call away.
 */
@Injectable()
export class ContextService {
  private readonly minCosine: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly search: SearchService,
    private readonly memory: MemoryRuntimeService,
    private readonly analytics: AnalyticsRecorder,
    config: ConfigService<Env, true>,
  ) {
    // ponytail: one cosine floor for pages and memory (same embedder); split into CONTEXT_MIN_COSINE if page cosines calibrate differently.
    this.minCosine = config.get('MEMORY_RUNTIME_MIN_SEMANTIC', { infer: true });
  }

  async context(dto: ContextRequest, scope: AccessScope, caller: AnalyticsCaller): Promise<ContextResponse> {
    const startedAt = Date.now();
    const exclude = new Set(dto.exclude ?? []);
    const budget = clampBudget(dto.budget);
    const [hits, projectIds] = await Promise.all([
      this.search.search(
        // A page per hit, and enough of them that the excluded ones leave four.
        { workspaceId: dto.workspaceId, query: dto.query, groupBy: 'page', limit: CONTEXT_LIMITS.pages + Math.min(exclude.size, 20) },
        scope,
      ),
      this.projectsFor(dto, scope),
    ]);
    const [terms, memories] = await Promise.all([
      this.termsFor(dto.workspaceId, dto.query, projectIds),
      this.memory.recallProjects({
        principal: caller.principal,
        workspaceId: dto.workspaceId,
        projectIds,
        query: dto.query,
        limit: CONTEXT_LIMITS.memories + exclude.size,
      }),
    ]);

    const pages: ContextPage[] = hits.results
      // A chunk the vector leg found needs the floor; one only BM25 found already matched a share of the query's terms (#400).
      .filter((r) => !exclude.has(r.documentId) && (r.vectorScore === undefined || r.vectorScore >= this.minCosine))
      .slice(0, CONTEXT_LIMITS.pages)
      .map((r) => {
        // The longest matched word says most about why the page matched («and» says nothing).
        const match = r.snippetParts?.filter((p) => p.hit).sort((a, b) => b.text.length - a.text.length)[0]?.text;
        return {
          documentId: r.documentId,
          title: r.title,
          status: r.trust?.status ?? 'unverified',
          ...(match ? { match } : {}),
          excerpt: clip((r.snippetParts?.map((p) => p.text).join('') ?? r.snippet).replace(/\s+/g, ' ').trim()),
        };
      });
    const res = packContext(
      {
        pages,
        memories: memories
          .filter((m) => !exclude.has(m.result.id))
          .slice(0, CONTEXT_LIMITS.memories)
          .map(({ bankId, result }) => ({
            id: result.id,
            status: 'unverified' as const,
            bankId,
            occurredAt: result.occurred_start ?? result.mentioned_at,
            text: clip(result.text.replace(/\s+/g, ' ').trim()),
          })),
        terms: terms
          .filter((t) => !exclude.has(t.termId))
          .slice(0, CONTEXT_LIMITS.terms),
      },
      projectIds,
      budget,
    );
    this.analytics.search(caller, {
      workspaceId: dto.workspaceId,
      query: dto.query,
      mode: 'context',
      projectIds,
      resultDocIds: res.pages.map((p) => p.documentId),
      resultTokens: res.tokens,
      resultCount: res.pages.length + res.memories.length + res.terms.length,
      durationMs: Date.now() - startedAt,
    });
    return res;
  }

  /**
   * The projects memory comes from: those whose code or docs connector reads
   * `repo`, plus `projectIds`, kept only when they are this workspace's and
   * the caller may see them — a restricted project's id is never echoed back.
   */
  private async projectsFor(dto: ContextRequest, scope: AccessScope): Promise<string[]> {
    const wanted = new Set(dto.projectIds ?? []);
    const key = dto.repo ? repositorySegments(dto.repo).join('/') : '';
    if (key) {
      const connectors = await this.prisma.connector.findMany({
        where: { workspaceId: dto.workspaceId, kind: { in: REPO_KINDS } },
        select: { projectId: true, config: true },
      });
      for (const c of connectors) {
        const url = (c.config as Record<string, unknown> | null)?.repoUrl;
        if (typeof url === 'string' && repositorySegments(url).join('/') === key) wanted.add(c.projectId);
      }
    }
    if (!wanted.size) return [];
    const rows = await this.prisma.project.findMany({
      where: { workspaceId: dto.workspaceId, id: { in: [...wanted] } },
      select: { id: true, restricted: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.filter((p) => canSeeProject(scope, p)).map((p) => p.id);
  }

  /** The vocabulary of those projects (or the workspace's alone), the terms the query names. */
  private async termsFor(workspaceId: string, query: string, projectIds: string[]): Promise<ContextTerm[]> {
    const scopes = await Promise.all(projectIds.map((p) => projectScope(this.prisma, p)));
    const blueprintIds = [...new Set(scopes.flatMap((s) => (s.blueprintId ? [s.blueprintId] : [])))];
    const rows = (
      await this.prisma.glossaryTerm.findMany({
        where: {
          workspaceId,
          OR: [
            { projectId: null, blueprintId: null },
            ...(projectIds.length ? [{ projectId: { in: projectIds } }] : []),
            ...(blueprintIds.length ? [{ projectId: null, blueprintId: { in: blueprintIds } }] : []),
          ],
        },
      })
    ).map((r) => ({ ...r, aliases: readAliases(r.aliases) }));
    // A project term replaces its methodology's (#1121), which replaces the
    // workspace's, enabled or not; only then do disabled ones drop. Each project
    // sees only its own methodology's terms.
    const vocabulary = scopes.length
      ? [
          ...new Map(
            scopes.flatMap((s) => effectiveGlossary(rows.filter((r) => !r.blueprintId || r.blueprintId === s.blueprintId), s.projectId)).map((t) => [t.id, t]),
          ).values(),
        ]
      : rows;
    return matchTerms(query, vocabulary.filter((t) => t.enabled), CONTEXT_LIMITS.terms).map((t) => ({
      termId: t.id,
      term: t.term,
      definition: clip(t.definition.split('\n')[0]!.trim()),
      documentId: t.documentId,
    }));
  }
}

export function clampBudget(budget: number | undefined): number {
  return Math.min(CONTEXT_BUDGET.max, Math.max(CONTEXT_BUDGET.min, Math.round(budget ?? CONTEXT_BUDGET.default)));
}

/** At most {@link CONTEXT_EXCERPT_CHARS}, an ellipsis when cut. */
export function clip(text: string): string {
  return text.length <= CONTEXT_EXCERPT_CHARS ? text : `${text.slice(0, CONTEXT_EXCERPT_CHARS - 1).trimEnd()}…`;
}

/**
 * The terms whose name — or alias, where the term links them — occurs in
 * `query` as a word, inflected forms included (`termPattern`), longest spelling first so
 * a longer term claims its words before a shorter one inside it. In the order
 * the query names them.
 */
export function matchTerms<T extends { id: string; term: string; aliases: string[]; matchAliases: boolean; caseSensitive: boolean }>(
  query: string,
  terms: readonly T[],
  limit: number,
): T[] {
  const spellings = terms
    .flatMap((t) => [t.term, ...(t.matchAliases ? t.aliases : [])].map((s) => ({ t, s: s.trim() })))
    .filter(({ s }) => s)
    .sort((a, b) => b.s.length - a.s.length);
  const taken: Array<[number, number]> = [];
  const found = new Map<string, { t: T; at: number }>();
  for (const { t, s } of spellings) {
    if (found.has(t.id)) continue;
    for (const m of query.matchAll(new RegExp(termPattern(s, { caseSensitive: t.caseSensitive }), t.caseSensitive ? 'gu' : 'giu'))) {
      const [from, to] = [m.index, m.index + m[0].length];
      if (taken.some(([a, b]) => from < b && a < to)) continue;
      taken.push([from, to]);
      found.set(t.id, { t, at: from });
      break;
    }
  }
  return [...found.values()]
    .sort((a, b) => a.at - b.at)
    .slice(0, limit)
    .map((f) => f.t);
}

/**
 * Fill pages → memories → terms within `budget` tokens of the answer as the
 * MCP tool renders it, dropping a whole item that does not fit — never cutting
 * one — and trying the next. Nothing left is the one-line "nothing relevant".
 */
export function packContext(
  candidates: Pick<ContextResponse, 'pages' | 'memories' | 'terms'>,
  projectIds: string[],
  budget: number,
): ContextResponse {
  // `tokens` holds the budget while packing: no wider than the final count, so the measure never comes in under it.
  const out: ContextResponse = { pages: [], memories: [], terms: [], projectIds, tokens: budget, empty: false };
  const size = () => estimateTokens(pageText(out, CONTEXT_TOOL));
  const fill = <T>(into: T[], items: T[]) => {
    for (const item of items) {
      into.push(item);
      if (size() > budget) into.pop();
    }
  };
  fill(out.pages, candidates.pages);
  fill(out.memories, candidates.memories);
  fill(out.terms, candidates.terms);
  if (!out.pages.length && !out.memories.length && !out.terms.length) Object.assign(out, { empty: true, reason: 'nothing-relevant' });
  out.tokens = size();
  return out;
}
