import { describe, expect, it, vi } from 'vitest';
import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PublicSiteSearchService, siteSearchQuery, snippetParts } from '../src/public/public-site-search.service.js';
import { SiteSearchTextService } from '../src/publishing/site-search-text.service.js';
import { SEARCH_BODY_MAX_CHARS, searchTextOf } from '../src/publishing/site-search.text.js';

/**
 * Site search (docs/features/44, issue #77 phase 2b-2). What is pinned:
 * - scope: one query, over `site_version_pages` of the resolved version only,
 *   after the same live-site check every public route makes — so a page that
 *   is not in that version's snapshot (a draft, an unpublished page, another
 *   version's) has no row to match; there is no other path, semantic or not;
 * - input: nothing a reader types reaches Postgres as tsquery syntax;
 * - output: hits come back as text runs, never as markup;
 * - text: markup stripped at build time, mermaid dropped, code kept, capped;
 * - reuse and backfill: text is read once per revision, and old snapshots
 *   are filled in place, matched on revision, never rebuilt.
 */

const SITE = '22222222-2222-4222-8222-222222222222';

function liveSite() {
  const latest = { id: 'v-latest', slug: 'latest' };
  const old = { id: 'v-old', slug: 'v1' };
  return { id: SITE, defaultVersion: latest, versions: [latest, old] };
}

/** A version's snapshot rows as the audience filter reads them; all public unless a spec says otherwise. */
type StampRow = { documentId: string; parentId: string | null; audience: string; audienceClaims: unknown };

function searcher(rows: Array<Record<string, string>> = [], stamps: StampRow[] = [], viewer: unknown = { kind: 'anonymous' }) {
  const sites = {
    findById: vi.fn(async (id: string) => (id === SITE ? liveSite() : Promise.reject(new NotFoundException()))),
    viewer: vi.fn(async () => viewer),
  };
  const prisma = {
    $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => rows),
    siteVersionPage: { findMany: vi.fn(async () => stamps) },
  };
  return { sites, prisma, service: new PublicSiteSearchService(sites as never, prisma as never) };
}

describe('siteSearchQuery', () => {
  it('ANDs the words and makes the last one a prefix, so results follow the typing', () => {
    expect(siteSearchQuery('Install the serv')).toBe('install & the & serv:*');
    expect(siteSearchQuery('Установка сервера')).toBe('установка & сервера:*');
  });

  it('keeps only letters and digits: no reader input is tsquery syntax', () => {
    expect(siteSearchQuery(`a' | b:* & !c <-> (d)`)).toBe('a & b & c & d:*');
    expect(siteSearchQuery("'); DROP TABLE x; --")).toBe('drop & table & x:*');
  });

  it('answers nothing for queries too short or with no words, and caps long ones', () => {
    expect(siteSearchQuery('a')).toBeNull();
    expect(siteSearchQuery('  ')).toBeNull();
    expect(siteSearchQuery('!!! ???')).toBeNull();
    expect(siteSearchQuery('w '.repeat(50))!.split(' & ')).toHaveLength(8);
  });
});

describe('snippetParts', () => {
  it('turns the headline markers into flagged runs, merging neighbours', () => {
    expect(snippetParts('To \u0001install\u0002 the \u0001server\u0002\u0001s\u0002.')).toEqual([
      { text: 'To ', hit: false },
      { text: 'install', hit: true },
      { text: ' the ', hit: false },
      { text: 'servers', hit: true },
      { text: '.', hit: false },
    ]);
  });

  it('passes markup through as text and drops a stray marker', () => {
    expect(snippetParts('<script>x</script> \u0002tail')).toEqual([{ text: '<script>x</script> tail', hit: false }]);
    expect(snippetParts('')).toEqual([]);
  });
});

describe('PublicSiteSearchService', () => {
  it('reads one version’s snapshot rows only: the default version unless one is named', async () => {
    const { service, prisma } = searcher();
    await service.search(SITE, { q: 'install' });
    await service.search(SITE, { q: 'install', version: 'v1' });
    const [first, second] = prisma.$queryRaw.mock.calls;
    const sql = first[0].join('?');
    // The only table, and the version filter: a page outside the snapshot has no row here.
    expect(sql).toMatch(/FROM site_version_pages\s+WHERE version_id = \?::uuid\s+AND search_vector @@/);
    expect(sql).not.toMatch(/\bdocuments\b|document_revisions|chunks/);
    expect(first.slice(1)).toContain('v-latest');
    expect(second.slice(1)).toContain('v-old');
    expect(second.slice(1)).not.toContain('v-latest');
  });

  it('is the live-site check first: a site that is not live, or an unknown version, is a 404 before any search', async () => {
    const { service, prisma } = searcher();
    await expect(service.search('99999999-9999-4999-8999-999999999999', { q: 'install' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.search(SITE, { q: 'install', version: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('answers nothing without asking Postgres for a query too short to search', async () => {
    const { service, prisma } = searcher();
    expect(await service.search(SITE, { q: 'a' })).toEqual({ results: [] });
    expect(await service.search(SITE, {})).toEqual({ results: [] });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('binds the query as a value, never as SQL text', async () => {
    const { service, prisma } = searcher();
    await service.search(SITE, { q: "x'); DROP TABLE site_version_pages; --" });
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0];
    expect(strings.join('')).not.toContain('DROP');
    expect(values).toContain('x & drop & table & site & version & pages:*');
  });

  it('maps rows to results with snippets as text runs', async () => {
    const { service } = searcher([
      { document_id: 'd1', title: 'Install', slug_path: 'guide/install', snippet: 'Run \u0001make\u0002 setup' },
      { document_id: 'd2', title: 'Empty', slug_path: 'empty', snippet: '' },
    ]);
    expect(await service.search(SITE, { q: 'make' })).toEqual({
      results: [
        { documentId: 'd1', title: 'Install', slugPath: 'guide/install', snippet: [{ text: 'Run ', hit: false }, { text: 'make', hit: true }, { text: ' setup', hit: false }] },
        { documentId: 'd2', title: 'Empty', slugPath: 'empty', snippet: [] },
      ],
    });
  });
});

describe('searchTextOf', () => {
  it('keeps the words, not the markup: headings apart, emphasis, links, images, tables and HTML flattened', () => {
    const text = searchTextOf(
      [
        '# Install',
        'Run **make setup** and see [the guide](https://x.test/g) ![a diagram](d.png).',
        '',
        '> [!NOTE]',
        '> Needs <kbd>Docker</kbd> &amp; Compose.',
        '',
        '| Var | Default |',
        '| --- | --- |',
        '| `PORT` | 3000 |',
        '',
        '## Configure',
        '- one',
        '- two ****bold',
      ].join('\n'),
    );
    expect(text.headings).toBe('Install Configure');
    expect(text.body).toBe('Run make setup and see the guide a diagram. Needs Docker & Compose. Var Default PORT 3000 one two bold');
  });

  it('keeps code, which readers search by identifier, and drops mermaid source', () => {
    const text = searchTextOf('```ts\nconst getContent = 1\n```\n\n```mermaid\ngraph TD; A-->B\n```');
    expect(text.body).toBe('const getContent = 1');
  });

  it('never holds the snippet markers, and is capped', () => {
    expect(searchTextOf('a\u0001b\u0002c').body).toBe('a b c');
    expect(searchTextOf('word '.repeat(50_000)).body.length).toBe(SEARCH_BODY_MAX_CHARS);
  });
});

describe('SiteSearchTextService', () => {
  function textService(opts: { known?: Array<Record<string, string>>; unreadable?: string[] } = {}) {
    const prisma = {
      siteVersionPage: {
        findMany: vi.fn(async () => opts.known ?? []),
        updateMany: vi.fn((args: unknown) => ({ op: 'update', args })),
      },
      documentRevision: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id, s3Key: `k/${id}` }))),
      },
      $executeRaw: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({ op: 'index', sql: strings.join('?'), values })),
      $queryRaw: vi.fn(),
      $transaction: vi.fn(async (ops: unknown[]) => ops),
    };
    const storage = {
      getObjectText: vi.fn(async (key: string) => {
        if (opts.unreadable?.some((id) => key.endsWith(id))) throw new Error('NoSuchKey');
        return `---\nsecret: frontmatter\n---\n# ${key}\nbody of ${key}`;
      }),
    };
    return { prisma, storage, service: new SiteSearchTextService(prisma as never, storage as never) };
  }

  it('copies text a snapshot already holds for a revision and reads only the rest', async () => {
    const { service, storage } = textService({ known: [{ revisionId: 'r1', searchHeadings: 'H1', searchBody: 'B1' }] });
    const texts = await service.texts(['r1', 'r2', 'r2']);
    expect(texts.get('r1')).toEqual({ headings: 'H1', body: 'B1' });
    // Frontmatter is not page text.
    expect(texts.get('r2')).toEqual({ headings: 'k/r2', body: 'body of k/r2' });
    expect(storage.getObjectText.mock.calls).toEqual([['k/r2']]);
  });

  it('indexes an unreadable revision by its title alone instead of failing the build', async () => {
    const { service } = textService({ unreadable: ['r2'] });
    const texts = await service.texts(['r1', 'r2']);
    expect(texts.get('r2')).toEqual({ headings: '', body: '' });
    expect(texts.get('r1')!.body).toBe('body of k/r1');
  });

  it('backfills old snapshots in place, matched on revision, vectors only where missing', async () => {
    const { service, prisma } = textService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ version_id: 'v-old' }])
      .mockResolvedValueOnce([{ document_id: 'd1', revision_id: 'r1' }]);
    expect(await service.backfill()).toBe(1);
    const ops = prisma.$transaction.mock.calls[0][0] as Array<{ op: string; args?: unknown; sql?: string; values?: unknown[] }>;
    expect(ops[0]).toEqual({
      op: 'update',
      args: { where: { versionId: 'v-old', documentId: 'd1', revisionId: 'r1' }, data: { searchHeadings: 'k/r1', searchBody: 'body of k/r1' } },
    });
    expect(ops[1].sql).toMatch(/WHERE version_id = \?::uuid AND search_vector IS NULL/);
    expect(ops[1].values).toContain('v-old');
  });
});
