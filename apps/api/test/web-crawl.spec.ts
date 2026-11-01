import { describe, expect, it, vi } from 'vitest';

/**
 * Crawled `web` trees (#674, phase 3).
 *
 * Pinned:
 * 1. URLs fold to one page each: no query, no fragment, `/x` = `/x/` = `/x/index.html`.
 * 2. Scope is the root's origin and path, segment-bounded, and pages only (no assets).
 * 3. Links come from every `<a href>` (nav included) or markdown links; sitemap `<loc>`s too.
 * 4. A page hangs under its nearest found ancestor path, else the root.
 * 5. The adapter yields the root, then each page's in-scope links (the root's
 *    sitemap too); the body it read is reused by staging's fetch, not refetched.
 * 6. Only the root failing fails the walk; a single-URL source has no children.
 * 7. One request at a time per host, the gap apart.
 * 8. A large first crawl or change waits for a person; a dropped page counts
 *    toward archiving only on a complete crawl.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { crawlScope, foldUrl, inScope, pageLinks, pathParents, sitemapLocs } = await import('../src/connectors/web-crawl.js');
const { WebAdapter } = await import('../src/connectors/adapters/web.adapter.js');
const { WebSourcesService } = await import('../src/connectors/web-sources.service.js');

const fetchMock = vi.mocked(safeFetch);
const ROOT = 'https://docs.example.com/guide/';

describe('crawl rules', () => {
  it('folds a URL to one spelling', () => {
    expect(foldUrl('https://docs.example.com/guide/a/?x=1#top')).toBe('https://docs.example.com/guide/a');
    expect(foldUrl('/guide/a/index.html', ROOT)).toBe('https://docs.example.com/guide/a');
    expect(foldUrl('b', 'https://docs.example.com/guide/a/')).toBe('https://docs.example.com/guide/a/b');
    expect(foldUrl('https://docs.example.com/')).toBe('https://docs.example.com');
    expect(foldUrl('mailto:x@example.com')).toBeNull();
    expect(foldUrl('javascript:void(0)')).toBeNull();
  });

  it('keeps to the root path, segment by segment, and to pages', () => {
    const scope = crawlScope('https://docs.example.com/guide');
    expect(inScope('https://docs.example.com/guide', scope)).toBe(true);
    expect(inScope('https://docs.example.com/guide/a/b', scope)).toBe(true);
    expect(inScope('https://docs.example.com/guide/a.md', scope)).toBe(true);
    expect(inScope('https://docs.example.com/guide-old', scope)).toBe(false);
    expect(inScope('https://docs.example.com/blog', scope)).toBe(false);
    expect(inScope('https://other.example.com/guide/a', scope)).toBe(false);
    expect(inScope('https://docs.example.com/guide/logo.png', scope)).toBe(false);
    expect(inScope('https://docs.example.com/x', crawlScope('https://docs.example.com/'))).toBe(true);
  });

  it('reads links from HTML (nav included) and markdown, and locs from a sitemap', () => {
    const html = '<nav><a href="a">A</a><a href="/guide/b/#x">B</a></nav><main><a href="https://x.org/">ext</a></main>';
    expect(pageLinks({ body: html, contentType: 'text/html', url: 'https://docs.example.com/guide/' })).toEqual([
      'https://docs.example.com/guide/a',
      'https://docs.example.com/guide/b',
      'https://x.org',
    ]);
    expect(pageLinks({ body: '[a](./a.md) and [b](b "t")', contentType: 'text/markdown', url: 'https://docs.example.com/guide/index.md' })).toEqual([
      'https://docs.example.com/guide/a.md',
      'https://docs.example.com/guide/b',
    ]);
    expect(sitemapLocs('<urlset><url><loc> https://d.example.com/a?x=1&amp;y=2 </loc></url></urlset>')).toEqual(['https://d.example.com/a?x=1&y=2']);
  });

  it('nests by the nearest found ancestor path, else the root', () => {
    const urls = [ROOT, 'https://docs.example.com/guide/a', 'https://docs.example.com/guide/a/b/c', 'https://docs.example.com/guide/z/y'];
    const parents = pathParents(ROOT, urls);
    expect(parents.get(ROOT)).toBeNull();
    expect(parents.get('https://docs.example.com/guide/a')).toBe(ROOT);
    expect(parents.get('https://docs.example.com/guide/a/b/c')).toBe('https://docs.example.com/guide/a');
    expect(parents.get('https://docs.example.com/guide/z/y')).toBe(ROOT);
  });
});

function ctx(config: Record<string, unknown>) {
  return {
    connectorId: 'c1',
    workspaceId: 'w1',
    config,
    credential: null,
    onStage: async () => undefined,
    debug: () => undefined,
    allowPrivate: false,
    userId: 'u1',
    locale: 'en' as const,
  };
}

/** Serve fixed bodies by URL; anything else is a 404. */
function serve(pages: Record<string, { body: string; type?: string }>) {
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input: string | URL | Request) => {
    const page = pages[String(input)];
    return page
      ? new Response(page.body, { status: 200, headers: { 'content-type': page.type ?? 'text/html' } })
      : new Response('nope', { status: 404 });
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('WebAdapter crawl', () => {
  const html = (title: string, links: string) => `<html><head><title>${title}</title></head><body><nav>${links}</nav><article><h1>${title}</h1><p>${'word '.repeat(60)}</p></article></body></html>`;

  it('yields the root, then its in-scope links and sitemap pages, and reuses the body it read', async () => {
    const adapter = new WebAdapter();
    adapter.gapMs = 0;
    serve({
      [ROOT]: { body: html('Guide', '<a href="a">A</a><a href="/blog">Blog</a><a href="./">Self</a><a href="a/logo.png">img</a>') },
      'https://docs.example.com/sitemap.xml': {
        body: '<urlset><url><loc>https://docs.example.com/guide/s</loc></url><url><loc>https://docs.example.com/other</loc></url></urlset>',
        type: 'application/xml',
      },
    });
    const c = ctx({ url: ROOT, crawl: 'tree' });

    const roots = await collect(adapter.children(c, null));
    expect(roots).toEqual([expect.objectContaining({ externalId: ROOT, hasChildren: true })]);

    const children = await collect(adapter.children(c, roots[0]!));
    expect(children.map((r) => r.externalId)).toEqual(['https://docs.example.com/guide/a', 'https://docs.example.com/guide/s']);
    expect(children.every((r) => r.parentExternalId === ROOT && r.hasChildren)).toBe(true);

    const requests = fetchMock.mock.calls.length;
    const doc = await adapter.fetch(c, { externalId: ROOT, title: ROOT, url: ROOT, knownVersion: '{"etag":"x"}' });
    expect(doc.title).toBe('Guide');
    expect(fetchMock.mock.calls.length).toBe(requests);
    // Taken once: the next fetch goes to the network.
    await adapter.fetch(c, { externalId: ROOT, title: ROOT, url: ROOT });
    expect(fetchMock.mock.calls.length).toBe(requests + 1);
  });

  it('fails the walk only when the root fails, and gives a single URL no children', async () => {
    const adapter = new WebAdapter();
    adapter.gapMs = 0;
    serve({});
    const c = ctx({ url: ROOT, crawl: 'tree' });
    await expect(collect(adapter.children(c, { externalId: ROOT, title: ROOT }))).rejects.toThrow();
    expect(await collect(adapter.children(c, { externalId: `${ROOT}missing`, title: 'x' }))).toEqual([]);

    const single = ctx({ url: ROOT });
    expect(await collect(adapter.children(single, null))).toEqual([expect.objectContaining({ hasChildren: false })]);
    fetchMock.mockClear();
    expect(await collect(adapter.children(single, { externalId: ROOT, title: ROOT }))).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks one host one request at a time, the gap apart', async () => {
    const adapter = new WebAdapter();
    adapter.gapMs = 80;
    const md = { body: '# A\n\ntext', type: 'text/markdown' };
    serve({ 'https://docs.example.com/a.md': md, 'https://docs.example.com/b.md': md });
    const started: number[] = [];
    const inner = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (...args) => {
      started.push(Date.now());
      return inner(...args);
    });
    const c = ctx({ url: ROOT });
    await Promise.all([
      adapter.fetch(c, { externalId: 'https://docs.example.com/a.md', title: 'a' }),
      adapter.fetch(c, { externalId: 'https://docs.example.com/b.md', title: 'b' }),
    ]);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(75);
  });
});

describe('WebSourcesService crawl bookkeeping', () => {
  const PAGE = 'https://docs.example.com/guide/a';
  function harness(opts: { links: Array<{ externalId: string; documentId: string; goneCount?: number }>; items: Array<{ externalId: string; status: string }>; creates: number }) {
    const links = opts.links.map((l, i) => ({ id: `l${i}`, goneCount: 0, ...l }));
    const archived: string[] = [];
    const prisma = {
      connectorLink: {
        count: vi.fn(async () => links.length),
        findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (where.retryAt ? [] : links)),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(links.find((l) => l.id === where.id)!, data)),
      },
      connectorRunItem: {
        count: vi.fn(async () => opts.creates),
        findMany: vi.fn(async () => opts.items),
      },
      document: {
        findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id }))),
        findUnique: vi.fn(async () => ({ title: 'A', archivedAt: null })),
      },
      pageLink: { findMany: vi.fn(async () => []) },
    };
    const settings = { limits: vi.fn(async () => ({ maxPages: 200, confirmFirst: 50, confirmChange: 20 })) };
    const config = { get: () => 1000 };
    const verification = { archive: vi.fn(async (id: string) => archived.push(id)), flag: vi.fn() };
    const notifications = { notify: vi.fn(async () => []) };
    const events = { announce: vi.fn(async () => undefined) };
    const service = new WebSourcesService(
      prisma as never,
      config as never,
      {} as never,
      {} as never,
      {} as never,
      verification as never,
      notifications as never,
      events as never,
      {} as never,
      {} as never,
      settings as never,
    );
    const row = { id: 'c1', workspaceId: 'w1', createdBy: 'owner', config: { url: ROOT, crawl: 'tree' } };
    return { service, row, links, archived };
  }
  const run = { id: 'r1', scope: null };

  it('waits for a person when a first crawl would create more than 50 pages', async () => {
    const big = harness({ links: [{ externalId: ROOT, documentId: 'd0' }], items: [], creates: 60 });
    expect(await big.service.confirmation(big.row as never, run as never)).toBe('connector.warning.crawlConfirmFirst');
    const small = harness({ links: [{ externalId: ROOT, documentId: 'd0' }], items: [], creates: 30 });
    expect(await small.service.confirmation(small.row as never, run as never)).toBeNull();
  });

  it('counts added plus dropped against the change limit on a later crawl', async () => {
    const links = [{ externalId: ROOT, documentId: 'd0' }, ...Array.from({ length: 10 }, (_, i) => ({ externalId: `${ROOT}p${i}`, documentId: `d${i + 1}` }))];
    const h = harness({ links, items: [{ externalId: ROOT, status: 'unchanged' }], creates: 11 });
    expect(await h.service.confirmation(h.row as never, run as never)).toBe('connector.warning.crawlConfirmChange');
    // 10 added + 10 dropped is exactly the limit: it lands.
    const atLimit = harness({ links, items: [{ externalId: ROOT, status: 'unchanged' }], creates: 10 });
    expect(await atLimit.service.confirmation(atLimit.row as never, run as never)).toBeNull();
    const scoped = await h.service.confirmation(h.row as never, { ...run, scope: [ROOT] } as never);
    expect(scoped).toBeNull();
  });

  it('archives a page missing from three complete crawls, and never counts a failed root', async () => {
    const h = harness({
      links: [{ externalId: ROOT, documentId: 'd0' }, { externalId: PAGE, documentId: 'd1' }],
      items: [{ externalId: ROOT, status: 'unchanged' }],
      creates: 0,
    });
    await h.service.afterRun(h.row as never, run as never);
    await h.service.afterRun(h.row as never, run as never);
    expect(h.archived).toEqual([]);
    await h.service.afterRun(h.row as never, run as never);
    expect(h.archived).toEqual(['d1']);
    expect(h.links[0]!.goneCount).toBe(0);

    const failed = harness({
      links: [{ externalId: ROOT, documentId: 'd0' }, { externalId: PAGE, documentId: 'd1' }],
      items: [{ externalId: ROOT, status: 'failed' }],
      creates: 0,
    });
    await failed.service.afterRun(failed.row as never, run as never);
    expect(failed.links[1]!.goneCount).toBe(0);
  });
});
