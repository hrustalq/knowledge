import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  SITE_SEARCH_MAX_CHARS,
  SITE_SEARCH_MAX_RESULTS,
  SITE_SEARCH_MIN_CHARS,
  type PublicSiteSearchResponse,
  type PublicSiteSearchSnippetPart,
} from '@knowledge/contracts';
import { t } from '../i18n/t.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PublicSitesService, visibleRows } from './public-sites.service.js';

/** Words a query is cut to; past this, a query is a paste, not a search. */
const MAX_TERMS = 8;
const MAX_TERM_CHARS = 64;

/**
 * Hits are marked with two control characters the stored text can never hold
 * (site-search.text.ts strips them), and turned into parts here, so no markup
 * from a page — or from Postgres — ever reaches the reader as HTML.
 */
const HIT_START = '\u0001';
const HIT_STOP = '\u0002';
const HEADLINE_OPTIONS = `StartSel=${HIT_START}, StopSel=${HIT_STOP}, MaxWords=24, MinWords=10, ShortWord=3, MaxFragments=2, FragmentDelimiter=" … "`;

/**
 * A reader's query as a tsquery: its words ANDed, the last one as a prefix so
 * results follow the typing. Only letters and digits survive, so nothing a
 * reader types is tsquery syntax. Null when there is nothing to search for.
 */
export function siteSearchQuery(raw: string): string | null {
  const q = raw.normalize('NFC').slice(0, SITE_SEARCH_MAX_CHARS);
  if (q.trim().length < SITE_SEARCH_MIN_CHARS) return null;
  const terms = (q.match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, MAX_TERMS).map((w) => w.slice(0, MAX_TERM_CHARS).toLowerCase());
  if (!terms.length) return null;
  return terms.map((w, i) => (i === terms.length - 1 ? `${w}:*` : w)).join(' & ');
}

/** `ts_headline` output → text runs, hits flagged. */
export function snippetParts(headline: string): PublicSiteSearchSnippetPart[] {
  const parts: PublicSiteSearchSnippetPart[] = [];
  for (const piece of headline.split(new RegExp(`(${HIT_START}[^${HIT_STOP}]*${HIT_STOP})`, 'u'))) {
    if (!piece) continue;
    const hit = piece.startsWith(HIT_START);
    const text = hit ? piece.slice(1, -1) : piece.replaceAll(HIT_START, '').replaceAll(HIT_STOP, '');
    const last = parts.at(-1);
    if (last && last.hit === hit) last.text += text;
    else parts.push({ text, hit });
  }
  return parts;
}

/**
 * Search over one published version (docs/features/44, issue #77 phase 2b-2).
 *
 * Postgres full-text search over the version's own snapshot rows — the rows
 * the reader serves, with the text the build stored from each pinned
 * revision. So a result can only be a page of that version, at the revision
 * that version shows: a draft, a page added since the build, or one the
 * snapshot left out has no row here to match. Keyword only; no embedding
 * path, so nothing from the workspace-wide vector index can leak in. Rows the
 * reader may not see (issue #77 phase 3) are filtered in the same statement,
 * so a hidden page is never ranked, counted or quoted.
 */
@Injectable()
export class PublicSiteSearchService {
  constructor(
    private readonly sites: PublicSitesService,
    private readonly prisma: PrismaService,
  ) {}

  async search(siteId: string, query: { q?: string; version?: string }, cookieHeader?: string): Promise<PublicSiteSearchResponse> {
    const site = await this.sites.findById(siteId);
    const version = query.version ? site.versions.find((v) => v.slug === query.version) : site.defaultVersion;
    if (!version) throw new NotFoundException(t('error.site.notFound'));
    const tsquery = siteSearchQuery(query.q ?? '');
    if (!tsquery) return { results: [] };
    const visible = await this.visibleFilter(site, version.id, cookieHeader);
    if (visible === null) return { results: [] };

    // Ranked and cut in the inner query; the headline, which re-parses the
    // body, is computed for the survivors only.
    const rows = await this.prisma.$queryRaw<{ document_id: string; title: string; slug_path: string; snippet: string }[]>`
      SELECT hit.document_id, hit.title, hit.slug_path,
             ts_headline('russian', hit.search_body, to_tsquery('russian', ${tsquery}), ${HEADLINE_OPTIONS}) AS snippet
      FROM (
        SELECT document_id, title, slug_path, search_body, depth, position,
               ts_rank_cd(search_vector, to_tsquery('russian', ${tsquery}), 1) AS rank
        FROM site_version_pages
        WHERE version_id = ${version.id}::uuid
          AND search_vector @@ to_tsquery('russian', ${tsquery})
          ${visible}
        ORDER BY rank DESC, depth, position
        LIMIT ${SITE_SEARCH_MAX_RESULTS}
      ) hit
      ORDER BY hit.rank DESC, hit.depth, hit.position`;

    return {
      results: rows.map((r) => ({
        documentId: r.document_id,
        title: r.title,
        slugPath: r.slug_path,
        snippet: snippetParts(r.snippet ?? ''),
      })),
    };
  }

  /**
   * The SQL condition that keeps a viewer to the rows they may read: nothing
   * for a version that is all theirs, an id list otherwise, and null when
   * they may read no row at all.
   */
  private async visibleFilter(
    site: Awaited<ReturnType<PublicSitesService['findById']>>,
    versionId: string,
    cookieHeader: string | undefined,
  ): Promise<Prisma.Sql | null> {
    const rows = await this.prisma.siteVersionPage.findMany({
      where: { versionId },
      orderBy: [{ depth: 'asc' }, { position: 'asc' }],
      select: { documentId: true, parentId: true, audience: true, audienceClaims: true },
    });
    if (rows.every((r) => r.audience === 'public')) return Prisma.empty;
    const visible = visibleRows(rows, await this.sites.viewer(site, cookieHeader));
    if (visible.length === rows.length) return Prisma.empty;
    if (!visible.length) return null;
    return Prisma.sql`AND document_id = ANY(${visible.map((r) => r.documentId)}::uuid[])`;
  }
}
