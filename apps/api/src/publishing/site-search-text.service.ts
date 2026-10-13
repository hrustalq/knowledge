import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import matter from 'gray-matter';
import { PrismaService } from '../prisma/prisma.service.js';
import { StorageService } from '../storage/storage.service.js';
import { searchTextOf, type SearchText } from './site-search.text.js';

/** Object reads in flight while collecting text, as the site's llms-full.txt does. */
const READ_CONCURRENCY = 8;

const EMPTY: SearchText = { headings: '', body: '' };

/**
 * title (A) + headings (B) + body (C). A fragment of SQL, never input: the
 * configuration name is a constant.
 */
const VECTOR = Prisma.raw(
  `setweight(to_tsvector('russian', title), 'A') || ` +
    `setweight(to_tsvector('russian', search_headings), 'B') || ` +
    `setweight(to_tsvector('russian', search_body), 'C')`,
);

/**
 * The search side of a site build (docs/features/44, issue #77 phase 2b-2).
 * Runs in the worker beside SiteBuildService.
 *
 * Text is per revision, and a revision never changes, so a page already in
 * any snapshot is copied from its row rather than read again: a rebuild after
 * one edit reads one object, not the whole site.
 */
@Injectable()
export class SiteSearchTextService implements OnApplicationBootstrap {
  private readonly logger = new Logger(SiteSearchTextService.name);
  private backfilling = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /**
   * Text for each revision. A revision that cannot be read is searched by its
   * title alone and logged, rather than failing the build: one broken object
   * must not freeze a whole site at its last snapshot.
   */
  async texts(revisionIds: string[]): Promise<Map<string, SearchText>> {
    const out = new Map<string, SearchText>();
    const wanted = [...new Set(revisionIds)];
    if (!wanted.length) return out;

    const known = await this.prisma.siteVersionPage.findMany({
      where: { revisionId: { in: wanted }, OR: [{ searchBody: { not: '' } }, { searchHeadings: { not: '' } }] },
      distinct: ['revisionId'],
      select: { revisionId: true, searchHeadings: true, searchBody: true },
    });
    for (const row of known) out.set(row.revisionId, { headings: row.searchHeadings, body: row.searchBody });

    const missing = wanted.filter((id) => !out.has(id));
    if (!missing.length) return out;
    const revisions = await this.prisma.documentRevision.findMany({
      where: { id: { in: missing } },
      select: { id: true, s3Key: true },
    });
    for (let i = 0; i < revisions.length; i += READ_CONCURRENCY) {
      const batch = revisions.slice(i, i + READ_CONCURRENCY);
      const texts = await Promise.all(
        batch.map((r) =>
          this.storage.getObjectText(r.s3Key).then(
            (raw) => searchTextOf(matter(raw).content),
            (e: unknown) => {
              this.logger.warn(`site search: revision ${r.id} unreadable, indexed by title only: ${(e as Error).message}`);
              return EMPTY;
            },
          ),
        ),
      );
      batch.forEach((r, j) => out.set(r.id, texts[j]));
    }
    for (const id of missing) if (!out.has(id)) out.set(id, EMPTY);
    return out;
  }

  /**
   * The statement that turns a version's rows into searchable vectors, for
   * the build's swap transaction. Weighted so a title match outranks a
   * heading match, which outranks a body match. `russian` stems Cyrillic words with
   * the Russian stemmer and ASCII words with the English one, so one
   * configuration serves both of the platform's languages.
   */
  indexVersion(versionId: string, onlyMissing = false) {
    return onlyMissing
      ? this.prisma.$executeRaw`
          UPDATE site_version_pages SET search_vector = ${VECTOR}
          WHERE version_id = ${versionId}::uuid AND search_vector IS NULL`
      : this.prisma.$executeRaw`
          UPDATE site_version_pages SET search_vector = ${VECTOR}
          WHERE version_id = ${versionId}::uuid`;
  }

  /**
   * Snapshots written before search existed (or by a build interrupted
   * between its insert and its vector, which the transaction rules out) have
   * no vector. Filled from their pinned revisions, never by rebuilding: a
   * rebuild would re-resolve a frozen version's pages.
   */
  onApplicationBootstrap(): void {
    void this.backfill().catch((e: Error) => this.logger.warn(`Site search backfill failed (non-fatal): ${e.message}`));
  }

  async backfill(): Promise<number> {
    if (this.backfilling) return 0;
    this.backfilling = true;
    try {
      const versions = await this.prisma.$queryRaw<{ version_id: string }[]>`
        SELECT DISTINCT version_id FROM site_version_pages WHERE search_vector IS NULL`;
      for (const { version_id: versionId } of versions) {
        const rows = await this.prisma.$queryRaw<{ document_id: string; revision_id: string }[]>`
          SELECT document_id, revision_id FROM site_version_pages
          WHERE version_id = ${versionId}::uuid AND search_vector IS NULL`;
        const texts = await this.texts(rows.map((r) => r.revision_id));
        // Matched on the revision too: a build that swapped the snapshot in
        // the meantime wrote its own text, and this must not overwrite it.
        await this.prisma.$transaction([
          ...rows.map((r) => {
            const text = texts.get(r.revision_id) ?? EMPTY;
            return this.prisma.siteVersionPage.updateMany({
              where: { versionId, documentId: r.document_id, revisionId: r.revision_id },
              data: { searchHeadings: text.headings, searchBody: text.body },
            });
          }),
          this.indexVersion(versionId, true),
        ]);
        this.logger.log(`site search: indexed ${rows.length} pages of version ${versionId}`);
      }
      return versions.length;
    } finally {
      this.backfilling = false;
    }
  }
}
