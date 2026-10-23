import { afterEach, describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';

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
  new EmbedSnapshotService(prisma as never, storage as never, new FigmaFilesService(prisma as never, connectors as never), config);
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

function fakePrisma(state: { refs?: unknown[]; ref?: unknown; node?: unknown; files?: unknown[]; connectors?: unknown[] } = {}) {
  return {
    $transaction: vi.fn(async (ops: unknown[]) => ops),
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
    const prisma = fakePrisma({ connectors: [figma({ allowlist: 'project:222' })] });
    const storage = { putObjectBytes: vi.fn(async () => undefined) };
    const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'figd_x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockImplementation(async (url) => {
      const u = new URL(String(url));
      if (u.pathname === '/v1/projects/222/files') return json({ files: [{ key: KEY, name: 'App' }] });
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
  });

  it('records a file the allowlist does not reach, and calls Figma for nothing else', async () => {
    const prisma = fakePrisma({ connectors: [figma({ allowlist: 'project:222' })] });
    const connectors = { contextFor: vi.fn(async (row: { config: unknown }) => ({ config: row.config, credential: 'x', allowPrivate: false, debug: () => undefined })) };
    mockFetch.mockResolvedValue(json({ files: [] }));
    const service = snapshots(prisma, { putObjectBytes: vi.fn() }, connectors);
    await service.render({ workspaceId: WS, fileKey: KEY, nodeId: '1:2', version: '7' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
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
