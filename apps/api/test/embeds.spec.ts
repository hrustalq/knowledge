import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Embed snapshots (#470, docs/features/64): what a revision records, the one
 * read-time access rule, the four states, the snapshot route's 404s, and one
 * render through a mocked Figma.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));
const { safeFetch } = await import('../src/common/safe-fetch.js');
const { EmbedsService, embedFileAllowed, stateOf, NOT_ALLOWLISTED } = await import('../src/embeds/embeds.service.js');
const { EmbedSnapshotService, figmaNodeText, figmaRenderScale } = await import('../src/embeds/embed-snapshot.service.js');
const { FigmaFilesService } = await import('../src/embeds/figma-files.service.js');
const snapshots = (prisma: unknown, storage: unknown, connectors: unknown) =>
  new EmbedSnapshotService(prisma as never, storage as never, new FigmaFilesService(prisma as never, connectors as never), ingestion as never, config);
const ingestion = { enqueue: vi.fn(async () => undefined) };
const { embedSnapshotKey } = await import('../src/embeds/embeds.constants.js');
const mockFetch = vi.mocked(safeFetch);

const WS = '11111111-1111-4111-8111-111111111111';
const DOC = '22222222-2222-4222-8222-222222222222';
const KEY = 'AbCdEfGhIj12';
const figma = (config: Record<string, string>, enabled = true) => ({ id: 'c1', kind: 'figma', enabled, config, createdAt: new Date() });
const env = { EMBED_MAX_ITEMS: 2, EMBED_SNAPSHOT_SCALE: 2, EMBED_SNAPSHOT_MAX_PX: 4096, EMBED_TEXT_MAX_BYTES: 20 } as Record<string, unknown>;
const config = { get: (k: string) => env[k] } as never;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

afterEach(() => mockFetch.mockReset());

describe('embedFileAllowed', () => {
  const file = { projectId: '222', teamId: '111' };
  it('passes on the project or its team, and only for an enabled figma connector', () => {
    expect(embedFileAllowed(file, figma({ allowlist: 'project:222' }))).toBe(true);
    expect(embedFileAllowed(file, figma({ allowlist: 'team:111' }))).toBe(true);
    expect(embedFileAllowed(file, figma({ allowlist: 'project:999' }))).toBe(false);
    expect(embedFileAllowed(file, figma({ allowlist: 'project:222' }, false))).toBe(false);
    expect(embedFileAllowed(file, null)).toBe(false);
  });
});

describe('stateOf', () => {
  const now = Date.now();
  const later = new Date(now + 60_000);
  it.each([
    ['blocked', { snapshotKey: 'k', error: null, retryAt: null }, 'unavailable'],
    ['allowed', { snapshotKey: 'k', error: null, retryAt: null }, 'ready'],
    ['allowed', undefined, 'rendering'],
    ['unknown', undefined, 'rendering'],
    ['allowed', { snapshotKey: null, error: 'boom', retryAt: later }, 'failed'],
    ['allowed', { snapshotKey: null, error: 'boom', retryAt: new Date(now - 1) }, 'rendering'],
    ['unknown', { snapshotKey: null, error: NOT_ALLOWLISTED, retryAt: later }, 'unavailable'],
  ] as const)('%s + %o → %s', (access, node, state) => expect(stateOf(access, node, now)).toBe(state));
});

describe('figma helpers', () => {
  it('keeps text layers once, in order, within the byte cap', () => {
    const node = {
      type: 'FRAME',
      children: [
        { type: 'TEXT', characters: 'Sign in' },
        { type: 'GROUP', children: [{ type: 'TEXT', characters: ' Sign  in ' }, { type: 'TEXT', characters: 'Email' }] },
        { type: 'TEXT', characters: 'Password is required' },
      ],
    };
    expect(figmaNodeText(node, 20)).toBe('Sign in\nEmail');
  });

  it('renders at the scale unless the long side would pass the cap', () => {
    expect(figmaRenderScale({ width: 400, height: 300 }, 2, 4096)).toBe(2);
    expect(figmaRenderScale({ width: 10_000, height: 300 }, 2, 4096)).toBe(0.4);
    expect(figmaRenderScale(null, 2, 4096)).toBe(2);
  });
});

function fakePrisma(state: { refs?: unknown[]; ref?: unknown; node?: unknown; files?: unknown[]; connectors?: unknown[]; heads?: unknown[] } = {}) {
  return {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
    $queryRaw: vi.fn(async () => state.heads ?? []),
    ingestionJob: { create: vi.fn(async () => ({ id: 'job-1' })) },
    revisionEmbed: {
      deleteMany: vi.fn(() => 'delete'),
      createMany: vi.fn((args: unknown) => args),
      findMany: vi.fn(async () => state.refs ?? []),
      findFirst: vi.fn(async () => state.ref ?? null),
    },
    embedNode: {
      findUnique: vi.fn(async () => state.node ?? null),
      findMany: vi.fn(async () => (state.node ? [state.node] : [])),
      upsert: vi.fn(async () => undefined),
    },
    embedFile: {
      findMany: vi.fn(async () => state.files ?? []),
      findUnique: vi.fn(async () => (state.files ?? [])[0] ?? null),
      deleteMany: vi.fn(() => 'deleteFiles'),
      upsert: vi.fn(() => 'upsertFile'),
    },
    connector: { findMany: vi.fn(async () => state.connectors ?? []) },
  };
}

describe('EmbedsService', () => {
  const storage = { presignGet: vi.fn(async () => 'https://minio/presigned') };

  it('records every item with what the markdown got wrong, and queues only the pinned ones', async () => {
    const prisma = fakePrisma();
    const queue = { add: vi.fn(async () => undefined) };
    const service = new EmbedsService(prisma as never, storage as never, config, queue as never);
    await service.recordRevision({
      workspaceId: WS,
      documentId: DOC,
      revisionId: 'r1',
      markdown: [
        '<figure data-kn-embed="grid">',
        `<a href="https://www.figma.com/design/${KEY}/?node-id=1-2" data-kn-version="7">A</a>`,
        `<a href="https://www.figma.com/design/${KEY}/?node-id=1-2" data-kn-version="7">A again</a>`,
        `<a href="https://www.figma.com/design/${KEY}/?node-id=1-3" data-kn-version="7">Over</a>`,
        '</figure>',
        '',
        `<figure data-kn-embed><a href="https://www.figma.com/design/${KEY}/">Unpinned</a><a href="https://example.com/x">Other</a></figure>`,
      ].join('\n'),
    });
    const rows = (prisma.revisionEmbed.createMany.mock.calls[0]![0] as { data: Array<Record<string, unknown>> }).data;
    expect(rows.map((r) => [r.groupIndex, r.position, r.nodeId, r.warning])).toEqual([
      [0, 0, '1:2', null],
      [0, 1, '1:2', null],
      [0, 2, '1:3', 'over-limit'],
      [1, 0, '', 'unpinned'],
      [1, 1, null, 'unknown-provider'],
    ]);
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add.mock.calls[0]![1]).toEqual({ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' });
  });

  describe('snapshotUrl', () => {
    const key = { fileKey: KEY, nodeId: '1:2', version: '7' };
    const ready = { snapshotKey: 'workspaces/x.png', error: null, retryAt: null };
    const file = { fileKey: KEY, projectId: '222', teamId: null, connectorId: 'c1' };

    it('404s when no revision of this document references the item, even for a member', async () => {
      const service = new EmbedsService(fakePrisma({ node: ready, files: [file], connectors: [figma({ allowlist: 'project:222' })] }) as never, storage as never, config, {} as never);
      await expect(service.snapshotUrl(DOC, key)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves it while the allowlist passes, and 404s once the project is removed', async () => {
      const ref = { workspaceId: WS };
      const allowed = new EmbedsService(fakePrisma({ ref, node: ready, files: [file], connectors: [figma({ allowlist: 'project:222' })] }) as never, storage as never, config, {} as never);
      await expect(allowed.snapshotUrl(DOC, key)).resolves.toBe('https://minio/presigned');
      const removed = new EmbedsService(fakePrisma({ ref, node: ready, files: [file], connectors: [figma({ allowlist: 'project:999' })] }) as never, storage as never, config, {} as never);
      await expect(removed.snapshotUrl(DOC, key)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});

describe('EmbedSnapshotService.render', () => {
  it('lists the allowlist, renders the pinned node and stores it content-addressed', async () => {
    const prisma = fakePrisma({ connectors: [figma({ allowlist: 'project:222' })], heads: [{ id: 'r1', document_id: DOC, s3_key: 'k', title: 'Page' }] });
    const storage = { putObjectBytes: vi.fn(async () => undefined) };
    const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'figd_x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/v2/folders/222/folders') return json({ folders: [] });
      if (u.pathname === '/v2/folders/222/files') return json({ files: [{ key: KEY, name: 'App' }] });
      if (u.pathname === `/v1/files/${KEY}/nodes`) {
        expect(u.searchParams.get('version')).toBe('7');
        return json({ nodes: { '1:2': { document: { type: 'FRAME', name: 'Sign-in', absoluteBoundingBox: { width: 390, height: 844 }, children: [{ type: 'TEXT', characters: 'Email' }] } } } });
      }
      if (u.pathname === `/v1/images/${KEY}`) {
        expect(u.searchParams.get('scale')).toBe('2');
        return json({ images: { '1:2': 'https://figma-renders.example/abc.png' } });
      }
      if (u.host === 'figma-renders.example') return new Response(new Uint8Array([137, 80, 78, 71]));
      throw new Error(`unexpected ${u}`);
    });
    const service = snapshots(prisma, storage, connectors);
    const job = { workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' };
    await service.render(job);

    expect(prisma.embedFile.upsert).toHaveBeenCalled();
    expect(storage.putObjectBytes).toHaveBeenCalledWith(embedSnapshotKey(job), new Uint8Array([137, 80, 78, 71]), 'image/png');
    expect(embedSnapshotKey(job)).toBe(`workspaces/${WS}/embeds/figma/${KEY}/1-2/7.png`);
    const saved = (prisma.embedNode.upsert.mock.calls[0]![0] as { create: Record<string, unknown> }).create;
    expect(saved).toMatchObject({ name: 'Sign-in', text: 'Email', width: 390, height: 844, snapshotKey: embedSnapshotKey(job), error: null });
    expect(saved.subtreeHash).toMatch(/^[0-9a-f]{64}$/);
    // Its text joins search through a reindex of the head that pins it.
    expect(prisma.ingestionJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ revisionId: 'r1', type: 'reindex', payload: expect.objectContaining({ reason: 'embed rendered' }) }),
    });
    expect(ingestion.enqueue).toHaveBeenCalledWith('job-1');
  });

  it('records a file the allowlist does not reach, and calls Figma for nothing else', async () => {
    const prisma = fakePrisma({ connectors: [figma({ allowlist: 'project:222' })] });
    const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockImplementation(async () => json({ folders: [], files: [] }));
    const service = snapshots(prisma, { putObjectBytes: vi.fn() }, connectors);
    await service.render({ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' });
    // Only the listing: the folder's subfolders, then its files.
    expect(mockFetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual(['/v2/folders/222/folders', '/v2/folders/222/files']);
    expect((prisma.embedNode.upsert.mock.calls[0]![0] as { create: Record<string, unknown> }).create.error).toBe(NOT_ALLOWLISTED);
  });

  it('writes a Figma failure to the row instead of throwing', async () => {
    const prisma = fakePrisma({
      connectors: [figma({ allowlist: 'project:222' })],
      files: [{ fileKey: KEY, projectId: '222', teamId: null, connectorId: 'c1' }],
    });
    const connectors = { contextFor: vi.fn(async () => ({ config: {}, credential: 'x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockResolvedValue(new Response('{"err":"Invalid token"}', { status: 403 }));
    const service = snapshots(prisma, { putObjectBytes: vi.fn() }, connectors);
    await expect(service.render({ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' })).resolves.toBeUndefined();
    const saved = (prisma.embedNode.upsert.mock.calls[0]![0] as { create: Record<string, unknown> }).create;
    expect(saved.error).toMatch(/403/);
    expect(saved.retryAt).toBeInstanceOf(Date);
  });
});

describe('FigmaFilesService (the picker)', () => {
  const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'x', allowPrivate: false, debug: () => undefined })) };
  const allowed = () =>
    fakePrisma({
      connectors: [{ ...figma({ allowlist: 'project:222' }), workspaceId: WS }],
      files: [{ fileKey: KEY, projectId: '222', teamId: null, connectorId: 'c1' }],
    });

  it('lists each page’s pickable top-level children with thumbnails at the current version', async () => {
    mockFetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === `/v1/files/${KEY}`) {
        return json({
          name: 'App',
          version: '9',
          document: {
            children: [
              { id: '0:1', name: 'Auth', children: [{ id: '1:2', name: 'Sign-in', type: 'FRAME' }, { id: '1:9', name: 'note', type: 'TEXT' }, { id: '1:5', name: 'Flows', type: 'SECTION' }] },
            ],
          },
        });
      }
      if (u.pathname === `/v1/images/${KEY}`) {
        expect(u.searchParams.get('version')).toBe('9');
        return json({ images: { '1:2': 'https://figma-renders.example/a.png', '1:5': null } });
      }
      throw new Error(`unexpected ${u}`);
    });
    const service = new FigmaFilesService(allowed() as never, connectors as never);
    await expect(service.frames(WS, KEY)).resolves.toEqual({
      fileKey: KEY,
      name: 'App',
      version: '9',
      board: false,
      pages: [
        {
          id: '0:1',
          name: 'Auth',
          frames: [
            { id: '1:2', name: 'Sign-in', type: 'FRAME', thumbnailUrl: 'https://figma-renders.example/a.png' },
            { id: '1:5', name: 'Flows', type: 'SECTION', thumbnailUrl: null },
          ],
        },
      ],
    });
  });

  it('pins a pasted node link to the current version with the node’s name', async () => {
    mockFetch.mockResolvedValueOnce(json({ version: '9', nodes: { '12:34': { document: { name: 'Sign-in / error' } } } }));
    const service = new FigmaFilesService(allowed() as never, connectors as never);
    await expect(service.resolve(WS, `https://www.figma.com/design/${KEY}/App?node-id=12-34&t=x`)).resolves.toEqual({
      url: `https://www.figma.com/design/${KEY}/?node-id=12-34`,
      version: '9',
      name: 'Sign-in / error',
      allowed: true,
    });
  });

  it('keeps a link outside every allowlist unpinned, and refuses a non-Figma one', async () => {
    mockFetch.mockResolvedValue(json({ files: [] }));
    const service = new FigmaFilesService(fakePrisma({ connectors: [{ ...figma({ allowlist: 'project:222' }), workspaceId: WS }] }) as never, connectors as never);
    await expect(service.resolve(WS, `https://www.figma.com/design/${KEY}/`)).resolves.toEqual({
      url: `https://www.figma.com/design/${KEY}/`,
      version: null,
      name: null,
      allowed: false,
    });
    await expect(service.resolve(WS, 'https://example.com/x')).resolves.toBeNull();
  });
});

describe('EmbedsService for search and agents', () => {
  const file = { fileKey: KEY, name: 'App design', projectId: '222', teamId: null, connectorId: 'c1' };
  const ref = (over: Record<string, unknown>) => ({ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7', caption: '', warning: null, groupIndex: 0, position: 0, url: 'u', ...over });

  it('turns cached text into one chunk per pinned item after the page’s own, and skips a file the allowlist no longer reaches', async () => {
    const node = { fileKey: KEY, nodeId: '1:2', version: '7', name: 'Sign-in', text: 'Email\nPassword', snapshotKey: 'k', error: null, retryAt: null };
    const prisma = fakePrisma({ refs: [ref({ caption: 'Empty state' }), ref({ position: 1 })], node, files: [file], connectors: [figma({ allowlist: 'project:222' })] });
    const service = new EmbedsService(prisma as never, {} as never, config, {} as never);
    await expect(service.chunksFor('r1', 4)).resolves.toEqual([
      { index: 4, text: 'Figma frame "Sign-in" in "App design"\nCaption: Empty state\nEmail\nPassword', headingPath: ['Figma', 'App design'] },
    ]);
    const revoked = fakePrisma({ refs: [ref({})], node, files: [file], connectors: [figma({ allowlist: 'project:999' })] });
    await expect(new EmbedsService(revoked as never, {} as never, config, {} as never).chunksFor('r1', 4)).resolves.toEqual([]);
  });

  it('finds pages through the caller’s scope and groups their items', async () => {
    const prisma = fakePrisma();
    prisma.$queryRaw.mockResolvedValueOnce([
      { document_id: DOC, title: 'Checkout', revision_id: 'r1', group_index: 1, position: 0, url: 'a', caption: 'Cart', node_id: '1:2', version: '7' },
      { document_id: DOC, title: 'Checkout', revision_id: 'r1', group_index: 1, position: 1, url: 'b', caption: '', node_id: '1:3', version: '7' },
    ]);
    const service = new EmbedsService(prisma as never, {} as never, config, {} as never);
    const scope = { workspaceId: WS, bypass: false, denied: new Set(['33333333-3333-4333-8333-333333333333']), guest: false } as never;
    await expect(service.usages(scope, { fileKey: KEY, nodeId: '1:2' })).resolves.toEqual([
      { documentId: DOC, title: 'Checkout', revisionId: 'r1', groups: [{ group: 1, items: [{ url: 'a', caption: 'Cart', version: '7' }, { url: 'b', caption: '', version: '7' }] }] },
    ]);
    // The tagged template's strings plus every interpolated Prisma.Sql fragment, as one statement.
    const [strings, ...values] = prisma.$queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
    const text = [...strings, ...values.map((v) => (v && typeof v === 'object' && 'sql' in v ? String((v as { sql: string }).sql) : ''))].join(' ');
    expect(text).toContain('pending_merge_request_id IS NULL');
    expect(text).toContain('restricted_by');
  });
});

describe('EmbedsService.publicMarkdown (#470)', () => {
  const md = [
    'Intro.',
    '',
    `<figure data-kn-embed="grid">\n<a href="https://www.figma.com/design/${KEY}/?node-id=1-2" data-kn-version="7">Sign-in</a>\n<a href="https://www.figma.com/design/OTHERKEY9999/?node-id=5-6" data-kn-version="3">Other</a>\n<figcaption>Flow &amp; more</figcaption>\n</figure>`,
  ].join('\n');
  const rows = [
    { id: 'item-a', workspaceId: WS, documentId: DOC, revisionId: 'r1', groupIndex: 0, position: 0, fileKey: KEY, nodeId: '1:2', version: '7', warning: null },
    { id: 'item-b', workspaceId: WS, documentId: DOC, revisionId: 'r1', groupIndex: 0, position: 1, fileKey: 'OTHERKEY9999', nodeId: '5:6', version: '3', warning: null },
  ];
  const service = () =>
    new EmbedsService(
      fakePrisma({
        refs: rows,
        node: { fileKey: KEY, nodeId: '1:2', version: '7', snapshotKey: 'k', error: null, retryAt: null },
        files: [{ fileKey: KEY, projectId: '222', teamId: null, connectorId: 'c1' }],
        connectors: [figma({ allowlist: 'project:222' })],
      }) as never,
      {} as never,
      config,
      {} as never,
    );

  it('never carries a Figma link; with snapshots on, only a ready allowlisted item gets an opaque id', async () => {
    const on = await service().publicMarkdown(md, 'r1', true);
    expect(on).not.toContain('figma.com');
    expect(on).not.toContain(KEY);
    expect(on).toContain('<a data-kn-item="item-a">Sign-in</a>');
    expect(on).toContain('<a>Other</a>');
    expect(on).toContain('<figcaption>Flow &amp; more</figcaption>');
    expect(on).toContain('Intro.');
  });

  it('with snapshots off, every item is its caption only', async () => {
    const off = await service().publicMarkdown(md, 'r1', false);
    expect(off).not.toContain('data-kn-item');
    expect(off).toContain('<a>Sign-in</a><a>Other</a>');
  });

  it('leaves a page with no groups untouched', async () => {
    await expect(service().publicMarkdown('Just prose with https://www.figma.com/design/X/.', 'r1', true)).resolves.toBe(
      'Just prose with https://www.figma.com/design/X/.',
    );
  });
});

describe('the change check (#470, phase 8)', () => {
  it('calls a node changed only when both hashes are known and differ', async () => {
    const { designChanged, staleMockupsSql } = await import('../src/embeds/embeds.service.js');
    expect(designChanged({ subtreeHash: 'a' }, { currentHash: 'b' })).toBe(true);
    expect(designChanged({ subtreeHash: 'a' }, { currentHash: 'a' })).toBe(false);
    expect(designChanged({ subtreeHash: null }, { currentHash: 'b' })).toBe(false);
    expect(designChanged({ subtreeHash: 'a' }, undefined)).toBe(false);
    // The SQL twin compares the same two columns.
    const sql = staleMockupsSql(Prisma.sql`b.head_revision_id`).sql;
    expect(sql).toContain('h.current_hash <> n.subtree_hash');
    expect(sql).toContain('n.subtree_hash IS NOT NULL');
  });

  it('checks a due connector, hashes each pinned node at the current version, and waits out the interval', async () => {
    const { EmbedChangeSweeper } = await import('../src/embeds/embed-change.sweeper.js');
    const { figmaSubtreeHash } = await import('../src/embeds/embed-snapshot.service.js');
    const node = { type: 'FRAME', name: 'Sign-in', children: [{ type: 'TEXT', characters: 'Email' }] };
    const connector = { id: 'c1', kind: 'figma', enabled: true, workspaceId: WS, config: {}, lastSyncedAt: null as Date | null };
    const prisma = {
      connector: { findMany: vi.fn(async () => [connector]), update: vi.fn(async ({ data }: { data: { lastSyncedAt: Date } }) => (connector.lastSyncedAt = data.lastSyncedAt)) },
      $queryRaw: vi.fn(async () => [{ file_key: KEY, node_id: '1:2' }, { file_key: KEY, node_id: '9:9' }]),
      embedNodeHead: { upsert: vi.fn(async () => undefined) },
      // A render that failed earlier and is due again (#470, AC: text appears after the next tick).
      embedNode: { findMany: vi.fn(async () => [{ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' }]) },
    };
    mockFetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      expect(u.pathname).toBe(`/v1/files/${KEY}/nodes`);
      expect(u.searchParams.get('version')).toBeNull();
      return json({ version: '99', nodes: { '1:2': { document: node }, '9:9': null } });
    });
    const embeds = { enqueue: vi.fn(async () => undefined) };
    const sweeper = new EmbedChangeSweeper(
      prisma as never,
      { contextFor: vi.fn(async () => ({ config: {}, credential: 'x', allowPrivate: false, debug: () => undefined })) } as never,
      embeds as never,
      { get: () => 6 } as never,
    );
    const now = new Date('2026-10-24T00:00:00Z');
    await sweeper.sweep(now);
    const upserts = prisma.embedNodeHead.upsert.mock.calls.map((c) => (c[0] as { create: Record<string, unknown> }).create);
    expect(upserts).toEqual([
      expect.objectContaining({ nodeId: '1:2', currentVersion: '99', currentHash: figmaSubtreeHash(node) }),
      expect.objectContaining({ nodeId: '9:9', currentHash: 'deleted' }),
    ]);
    expect(connector.lastSyncedAt).toEqual(now);
    expect(prisma.embedNode.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { snapshotKey: null, retryAt: { lte: now } } }));
    expect(embeds.enqueue).toHaveBeenCalledWith(WS, [{ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' }]);
    // Not due again within the interval.
    await sweeper.sweep(new Date(now.getTime() + 60 * 60_000));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    await sweeper.sweep(new Date(now.getTime() + 7 * 3_600_000));
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });
});
