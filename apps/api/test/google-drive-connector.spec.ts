import { createVerify, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';

/**
 * The Google Drive connector (#338), against a mocked Drive API.
 *
 * The HTTP layer (`safeFetch`) is replaced by a small fake of the Drive,
 * Directory and token endpoints; Prisma is an in-memory store; storage and the
 * documents service are fakes. The adapter, the discovery, staging, sync and
 * ACL services are the real ones — so a run here is the run the worker does.
 *
 * Pinned:
 * 1. A folder stages one page per supported file, nested as Drive nests them,
 *    in review mode; unsupported files are skipped and named on the run.
 * 2. Syncing again with nothing changed reports every item `unchanged`.
 * 3. A file restricted in Drive arrives restricted with `acl_mode = mirror`.
 * 4. The Changes API cursor is bookmarked before the walk, moves only when a
 *    run finishes, and a scheduled run reads only what changed from it.
 * 5. A trashed or unshared linked file is reported and its page kept.
 * 6. Test connection succeeds against the mocked API.
 */
vi.mock('../src/common/safe-fetch.js', () => ({ safeFetch: vi.fn() }));

const { safeFetch } = await import('../src/common/safe-fetch.js');
const { encryptSecret } = await import('../src/ai/secret-box.js');
const {
  GoogleDriveAdapter,
  drivePermissionsToAcl,
  parseServiceAccountKey,
  planFile,
  serviceAccountAssertion,
  titleOf,
} = await import('../src/connectors/adapters/google-drive.adapter.js');
const { PlaintextParser } = await import('../src/import/parsers/plaintext.parser.js');
const { ConnectorsService } = await import('../src/connectors/connectors.service.js');
const { ConnectorDiscoveryService } = await import('../src/connectors/connector-discovery.service.js');
const { ConnectorStagingService } = await import('../src/connectors/connector-staging.service.js');
const { ConnectorSyncService } = await import('../src/connectors/connector-sync.service.js');
const { ConnectorAclService } = await import('../src/connectors/connector-acl.service.js');
type ConnectorContext = import('../src/connectors/adapters/connector.types.js').ConnectorContext;

// Warnings are catalogued: load the real catalogs, as api-spec-sync.spec does.
{
  const { join } = await import('node:path');
  const { Test } = await import('@nestjs/testing');
  const { I18nJsonLoader, I18nModule } = await import('nestjs-i18n');
  const { I18nRegistry } = await import('../src/i18n/t.js');
  const moduleRef = await Test.createTestingModule({
    imports: [
      I18nModule.forRoot({
        fallbackLanguage: 'en',
        loader: I18nJsonLoader,
        loaderOptions: { path: join(import.meta.dirname, '../src/i18n'), watch: false },
      }),
    ],
    providers: [I18nRegistry],
  }).compile();
  await moduleRef.init();
}

const mockFetch = vi.mocked(safeFetch);

// ---------------------------------------------------------------------------
// The service account and the mocked Drive.
// ---------------------------------------------------------------------------

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA_EMAIL = 'kb-reader@acme-docs.iam.gserviceaccount.com';
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: SA_EMAIL,
  // As Google ships it: a PEM with its newlines escaped inside the JSON string.
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  token_uri: 'https://evil.example/token',
});

const ROOT = 'rootFolder1';
const DOC = 'application/vnd.google-apps.document';
const FOLDER = 'application/vnd.google-apps.folder';

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  parents: string[];
  trashed?: boolean;
  size?: string;
  driveId?: string;
  /** What the export or download returns. */
  body?: string;
  permissions?: Array<Record<string, unknown>>;
}

const ORG_WIDE = [{ id: 'p-dom', type: 'domain', role: 'reader', domain: 'acme.test' }];

function driveFixture(): Map<string, FakeFile> {
  const files: FakeFile[] = [
    { id: ROOT, name: 'Handbook', mimeType: FOLDER, version: '1', parents: ['myDrive'] },
    { id: 'eng', name: 'Engineering', mimeType: FOLDER, version: '5', parents: [ROOT], permissions: ORG_WIDE },
    { id: 'welcome', name: 'Welcome', mimeType: DOC, version: '7', parents: [ROOT], body: '# Welcome\n\nHello team.', permissions: ORG_WIDE },
    { id: 'logo', name: 'logo.png', mimeType: 'image/png', version: '2', parents: [ROOT], size: '2048' },
    {
      id: 'runbook',
      name: 'Runbook.md',
      mimeType: 'text/markdown',
      version: '3',
      parents: ['eng'],
      size: '40',
      body: '# Runbook\n\nRestart the thing.',
      permissions: ORG_WIDE,
    },
    {
      id: 'secret',
      name: 'Secret plan',
      mimeType: DOC,
      version: '9',
      parents: ['eng'],
      body: 'Only Alice reads this.',
      permissions: [
        { id: 'p1', type: 'user', role: 'writer', emailAddress: 'Alice@Acme.test', displayName: 'Alice' },
        { id: 'p2', type: 'user', role: 'reader', emailAddress: SA_EMAIL },
      ],
    },
    // Outside the connector's folder entirely.
    { id: 'elsewhere', name: 'Elsewhere', mimeType: DOC, version: '1', parents: ['otherFolder'], body: 'nope' },
    { id: 'otherFolder', name: 'Other', mimeType: FOLDER, version: '1', parents: ['myDrive'] },
  ];
  return new Map(files.map((f) => [f.id, f]));
}

let drive = driveFixture();
/** The change feed, per page token. */
let feed: Record<string, { changes: unknown[]; newStartPageToken?: string; nextPageToken?: string }> = {};
let startToken = '100';
const tokenRequests: string[] = [];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function meta(f: FakeFile) {
  return {
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    version: f.version,
    parents: f.parents,
    webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
    trashed: f.trashed ?? false,
    ...(f.size ? { size: f.size } : {}),
    ...(f.driveId ? { driveId: f.driveId } : {}),
  };
}

function fakeGoogle(input: string | URL | Request, init?: RequestInit): Response {
  const url = new URL(String(input));
  if (url.href === 'https://oauth2.googleapis.com/token') {
    const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
    tokenRequests.push(assertion);
    return json({ access_token: 'ya29.fake', expires_in: 3600 });
  }
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== 'Bearer ya29.fake') return json({ error: 'unauthenticated' }, 401);

  const path = url.pathname.replace('/drive/v3', '');
  if (path === '/files') {
    const parent = /^'([^']+)' in parents and trashed = false$/.exec(url.searchParams.get('q') ?? '')?.[1];
    const files = [...drive.values()].filter((f) => f.parents.includes(parent ?? '') && !f.trashed);
    return json({ files: files.map(meta) });
  }
  if (path.startsWith('/drives/')) return json({ name: 'Team Docs' });
  if (path === '/changes/startPageToken') return json({ startPageToken: startToken });
  if (path === '/changes') {
    const page = feed[url.searchParams.get('pageToken') ?? ''];
    if (!page) return json({ error: { message: 'Invalid page token' } }, 400);
    return json(page);
  }
  let m = /^\/files\/([^/]+)\/permissions$/.exec(path);
  if (m) return json({ permissions: drive.get(m[1])?.permissions ?? [] });
  m = /^\/files\/([^/]+)\/export$/.exec(path);
  if (m) return new Response(drive.get(m[1])?.body ?? '', { status: 200 });
  m = /^\/files\/([^/]+)$/.exec(path);
  if (m) {
    const f = drive.get(m[1]);
    if (!f) return json({ error: 'notFound' }, 404);
    if (url.searchParams.get('alt') === 'media') return new Response(f.body ?? '', { status: 200 });
    return json(meta(f));
  }
  return json({ error: `unmocked ${url.href}` }, 500);
}

/**
 * The parser registry: the real plaintext parser for files, and for a Doc
 * exported to DOCX a stand-in that reads the export as text (the mocked
 * export is text, not a zip) and lifts one image the way mammoth would.
 */
const plaintext = new PlaintextParser();
const parsers = {
  resolve: (filename: string) => {
    if (filename.endsWith('.docx')) {
      return {
        id: 'docx',
        parse: async (bytes: Uint8Array) => ({
          markdown: `${new TextDecoder().decode(bytes)}\n\n![](/v1/imports/x/images/0)`,
          warnings: [],
          meta: {},
          images: [{ index: 0, filename: 'image-1.png', contentType: 'image/png', bytes: new Uint8Array() }],
        }),
      };
    }
    return filename.endsWith('.md') ? plaintext : null;
  },
};

const adapter = new GoogleDriveAdapter(parsers as never);

const ctxFor = (config: Record<string, string> = { folderId: ROOT }): ConnectorContext => ({
  connectorId: 'conn-1',
  workspaceId: 'ws-1',
  config,
  credential: KEY_JSON,
  onStage: async () => undefined,
  debug: () => undefined,
  allowPrivate: false,
  userId: null,
  locale: 'en',
});

beforeEach(() => {
  drive = driveFixture();
  feed = {};
  startToken = '100';
  tokenRequests.length = 0;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (input, init) => fakeGoogle(input as string, init));
});

// ---------------------------------------------------------------------------
// The adapter on its own.
// ---------------------------------------------------------------------------

describe('Google Drive adapter', () => {
  it('signs an RS256 assertion the service account public key verifies, at the fixed token URL', () => {
    const key = parseServiceAccountKey(KEY_JSON);
    const jwt = serviceAccountAssertion(key, 'scope-a', 'docs@acme.test', Date.parse('2026-10-20T00:00:00Z'));
    const [header, claims, signature] = jwt.split('.');
    expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString())).toMatchObject({
      iss: SA_EMAIL,
      scope: 'scope-a',
      sub: 'docs@acme.test',
      // Never the key's own token_uri: that would be a URL an admin pasted.
      aud: 'https://oauth2.googleapis.com/token',
    });
  });

  it('refuses a credential that is not a service account key', () => {
    expect(() => parseServiceAccountKey('ghp_notakey')).toThrow();
    expect(() => parseServiceAccountKey(JSON.stringify({ client_email: 'x' }))).toThrow();
  });

  it('routes files through the import formats, exporting Google-native ones and skipping images', () => {
    expect(planFile({ name: 'Plan', mimeType: DOC })).toMatchObject({ kind: 'export', filename: 'Plan.docx' });
    expect(planFile({ name: 'Deck', mimeType: 'application/vnd.google-apps.presentation' })).toMatchObject({
      kind: 'export',
      filename: 'Deck.pptx',
    });
    expect(planFile({ name: 'spec.pdf', mimeType: 'application/pdf', size: '10' })).toMatchObject({ kind: 'download' });
    // A Drive name need not carry its extension; the parser routes by it.
    expect(planFile({ name: 'notes', mimeType: 'text/markdown', size: '1' })).toMatchObject({ filename: 'notes.md' });
    expect(planFile({ name: 'logo.png', mimeType: 'image/png', size: '1' })).toEqual({ kind: 'skip', reason: 'unsupported' });
    expect(planFile({ name: 'a.zip', mimeType: 'application/zip' })).toEqual({ kind: 'skip', reason: 'unsupported' });
    expect(planFile({ name: 'huge.pdf', mimeType: 'application/pdf', size: String(50 * 1024 * 1024) })).toEqual({
      kind: 'skip',
      reason: 'oversize',
    });
    expect(planFile({ name: 'Folder', mimeType: FOLDER })).toEqual({ kind: 'folder' });
    expect(titleOf({ name: 'Runbook.md', mimeType: 'text/markdown' })).toBe('Runbook');
    expect(titleOf({ name: 'v1.2 notes', mimeType: DOC })).toBe('v1.2 notes');
  });

  it('reads Drive sharing as one restriction, keyed by email, without the service account', () => {
    expect(drivePermissionsToAcl([{ type: 'anyone', role: 'reader' }], SA_EMAIL)).toEqual({ audience: 'source-wide', principals: [] });
    expect(drivePermissionsToAcl([{ type: 'domain', role: 'reader' }], SA_EMAIL).audience).toBe('source-wide');
    expect(
      drivePermissionsToAcl(
        [
          { type: 'user', role: 'owner', emailAddress: 'Bob@acme.test', displayName: 'Bob' },
          { type: 'group', role: 'commenter', emailAddress: 'eng@acme.test' },
          { type: 'user', role: 'reader', emailAddress: SA_EMAIL.toUpperCase() },
          { type: 'user', role: 'reader', emailAddress: 'gone@acme.test', deleted: true },
        ],
        SA_EMAIL,
      ),
    ).toEqual({
      audience: 'restricted',
      principals: [
        { type: 'user', externalId: 'bob@acme.test', email: 'bob@acme.test', name: 'Bob', level: 'edit' },
        { type: 'group', externalId: 'eng@acme.test', email: 'eng@acme.test', level: 'view' },
      ],
    });
  });

  it('walks a folder as a tree and names what it skipped', async () => {
    const ctx = ctxFor();
    const warnings: string[] = [];
    ctx.warn = (m) => warnings.push(m);
    const roots = [];
    for await (const ref of adapter.children(ctx, null)) roots.push(ref);
    expect(roots.map((r) => [r.externalId, r.title, r.parentExternalId, r.hasChildren, r.version])).toEqual([
      ['eng', 'Engineering', undefined, true, '5'],
      ['welcome', 'Welcome', undefined, false, '7'],
    ]);
    expect(warnings).toEqual([expect.stringContaining('logo.png')]);

    const nested = [];
    for await (const ref of adapter.children(ctx, roots[0])) nested.push(ref);
    expect(nested.map((r) => [r.externalId, r.parentExternalId])).toEqual([
      ['runbook', 'eng'],
      ['secret', 'eng'],
    ]);
    // One token for the whole walk.
    expect(tokenRequests).toHaveLength(1);
  });

  it('exports a Doc, drops the images it cannot carry yet, and keeps the source link', async () => {
    const doc = await adapter.fetch(ctxFor(), { externalId: 'welcome', title: 'Welcome' });
    expect(doc.title).toBe('Welcome');
    expect(doc.markdown).toBe('Hello team.');
    expect(doc.frontmatter).toEqual({ source: 'https://drive.google.com/file/d/welcome/view' });
    expect(doc.warnings).toEqual([expect.stringContaining('1 image')]);
    const exportCall = mockFetch.mock.calls.find(([u]) => String(u).includes('/export'));
    expect(String(exportCall?.[0])).toContain(encodeURIComponent('application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
  });

  it('bookmarks the change feed with a null cursor, then advances the pageToken page by page', async () => {
    expect(await adapter.changes(ctxFor(), null)).toEqual({ cursor: '100', changed: [], removed: [] });

    drive.get('runbook')!.version = '4';
    drive.get('welcome')!.trashed = true;
    feed = {
      '100': {
        nextPageToken: '101',
        changes: [
          { changeType: 'file', fileId: 'runbook', file: meta(drive.get('runbook')!) },
          { changeType: 'file', fileId: 'welcome', file: meta(drive.get('welcome')!) },
          { changeType: 'drive', driveId: 'x' },
        ],
      },
      '101': {
        newStartPageToken: '102',
        changes: [
          // Unshared from the service account: Drive only says it is gone.
          { changeType: 'file', fileId: 'secret', removed: true },
          // Changed, but outside the connector's folder.
          { changeType: 'file', fileId: 'elsewhere', file: meta(drive.get('elsewhere')!) },
        ],
      },
    };
    const out = await adapter.changes(ctxFor(), '100');
    expect(out.cursor).toBe('102');
    expect(out.changed.map((r) => [r.externalId, r.version, r.parentExternalId])).toEqual([['runbook', '4', 'eng']]);
    expect(out.removed).toEqual(
      expect.arrayContaining([
        { externalId: 'welcome', reason: 'trashed' },
        { externalId: 'secret', reason: 'removed' },
        { externalId: 'elsewhere', reason: 'removed' },
      ]),
    );
  });

  it('names a shared drive in the change feed by driveId, and lists it as one corpus', async () => {
    drive.get(ROOT)!.driveId = ROOT;
    const ctx = { ...ctxFor(), connectorId: 'conn-shared' };
    expect(await adapter.testConnection(ctx)).toEqual({ ok: true, detail: 'Team Docs (shared drive)' });
    for await (const _ref of adapter.children(ctx, null)) void _ref;
    feed = { '100': { newStartPageToken: '101', changes: [] } };
    await adapter.changes(ctx, '100');
    const urls = mockFetch.mock.calls.map(([u]) => new URL(String(u)));
    const list = urls.find((u) => u.pathname === '/drive/v3/files')!;
    expect(list.searchParams.get('corpora')).toBe('drive');
    expect(list.searchParams.get('driveId')).toBe(ROOT);
    const changes = urls.find((u) => u.pathname === '/drive/v3/changes')!;
    expect(changes.searchParams.get('driveId')).toBe(ROOT);
    expect(changes.searchParams.has('corpora')).toBe(false);
  });

  it('refuses a page token Drive no longer accepts', async () => {
    await expect(adapter.changes(ctxFor(), 'stale')).rejects.toThrow(/400/);
  });

  it('reads group members from the Directory API only with delegation', async () => {
    await expect(adapter.groupMembers(ctxFor(), { type: 'group', externalId: 'eng@acme.test', level: 'view' })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// POST /v1/connectors/:id/test — the service the controller calls.
// ---------------------------------------------------------------------------

describe('Test connection', () => {
  const key = randomBytes(32);
  const service = (config: Record<string, string>) => {
    const row = {
      id: 'conn-1',
      workspaceId: 'ws-1',
      kind: 'google-drive',
      config,
      credential: encryptSecret(KEY_JSON, key),
      webhookSecret: null,
      createdBy: null,
      locale: 'en',
    };
    const settings: Record<string, unknown> = {
      SETTINGS_ENCRYPTION_KEY: key.toString('base64'),
      CONNECTOR_ALLOW_PRIVATE_URLS: false,
      CONNECTOR_DEBUG: false,
    };
    return new ConnectorsService(
      { connector: { findUnique: async () => row } } as never,
      { get: (k: string) => settings[k] } as never,
      { resolve: () => adapter } as never,
      {} as never,
      {} as never,
    );
  };

  it('passes against the mocked Drive API and names the folder', async () => {
    expect(await service({ folderId: ROOT }).testConnection('conn-1')).toEqual({ ok: true, detail: 'Handbook' });
  });

  it('fails with the reason when the id names a file', async () => {
    const res = await service({ folderId: 'welcome' }).testConnection('conn-1');
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/not a folder/);
  });
});

// ---------------------------------------------------------------------------
// The sync engine over the mocked Drive.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

/** A Prisma delegate over an array — just the query shapes the connector services use. */
class Table {
  rows: Row[] = [];
  constructor(
    private readonly defaults: () => Row = () => ({}),
    private readonly uniques: string[][] = [],
  ) {}

  private matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, v]) => {
      if (k === 'OR') return (v as Row[]).some((w) => this.matches(row, w));
      if (k === 'AND') return (v as Row[]).every((w) => this.matches(row, w));
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        const op = v as Row;
        if ('in' in op) return (op.in as unknown[]).includes(row[k]);
        if ('notIn' in op) return !(op.notIn as unknown[]).includes(row[k]);
        if ('not' in op) return row[k] !== op.not;
        if ('equals' in op) return row[k] === op.equals;
        return this.matches(row, op); // a compound unique key
      }
      return (row[k] ?? null) === v;
    });
  }

  private clean(data: Row): Row {
    return Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v === Prisma.DbNull || v === Prisma.JsonNull ? null : v]),
    );
  }

  private sorted(rows: Row[], orderBy?: Row | Row[]): Row[] {
    const keys = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
    return [...rows].sort((a, b) => {
      for (const o of keys) {
        const [k, dir] = Object.entries(o)[0];
        const av = a[k] as number;
        const bv = b[k] as number;
        if (av !== bv) return (av < bv ? -1 : 1) * (dir === 'desc' ? -1 : 1);
      }
      return 0;
    });
  }

  create = async ({ data }: { data: Row }): Promise<Row> => {
    const row = { id: randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...this.defaults(), ...this.clean(data) };
    for (const u of this.uniques) {
      if (this.rows.some((r) => u.every((k) => r[k] === row[k]))) {
        throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
      }
    }
    this.rows.push(row);
    return { ...row };
  };
  createMany = async ({ data }: { data: Row[] }) => {
    for (const d of data) await this.create({ data: d });
    return { count: data.length };
  };
  findUnique = async ({ where }: { where: Row }) => {
    const row = this.rows.find((r) => this.matches(r, where));
    return row ? { ...row } : null;
  };
  findUniqueOrThrow = async (args: { where: Row }) => {
    const row = await this.findUnique(args);
    if (!row) throw new Error('not found');
    return row;
  };
  findFirst = async ({ where, orderBy }: { where?: Row; orderBy?: Row | Row[] } = {}) => {
    const row = this.sorted(this.rows.filter((r) => this.matches(r, where)), orderBy)[0];
    return row ? { ...row } : null;
  };
  findMany = async ({ where, orderBy, take }: { where?: Row; orderBy?: Row | Row[]; take?: number } = {}) =>
    this.sorted(this.rows.filter((r) => this.matches(r, where)), orderBy)
      .slice(0, take ?? Infinity)
      .map((r) => ({ ...r }));
  count = async ({ where }: { where?: Row } = {}) => this.rows.filter((r) => this.matches(r, where)).length;
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => this.matches(r, where));
    if (!row) throw new Error('update: not found');
    Object.assign(row, this.clean(data), { updatedAt: new Date() });
    return { ...row };
  };
  updateMany = async ({ where, data }: { where: Row; data: Row }) => {
    const hit = this.rows.filter((r) => this.matches(r, where));
    for (const r of hit) Object.assign(r, this.clean(data));
    return { count: hit.length };
  };
  upsert = async ({ where, create, update }: { where: Row; create: Row; update: Row }) =>
    (await this.findUnique({ where })) ? this.update({ where, data: update }) : this.create({ data: create });
  delete = async ({ where }: { where: Row }) => {
    const i = this.rows.findIndex((r) => this.matches(r, where));
    const [row] = this.rows.splice(i, 1);
    return row;
  };
  deleteMany = async ({ where }: { where?: Row } = {}) => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => !this.matches(r, where));
    return { count: before - this.rows.length };
  };
}

const OWNER = '11111111-1111-4111-8111-111111111111';
const ALICE = '22222222-2222-4222-8222-222222222222';
const DEST = '33333333-3333-4333-8333-333333333333';

function engine(options: { aclMode?: string } = {}) {
  const itemDefaults = () => ({
    parentItemId: null,
    externalParentId: null,
    externalUrl: null,
    externalVersion: null,
    hasChildren: false,
    action: null,
    contentHash: null,
    stagedKey: null,
    incomingKey: null,
    linkId: null,
    documentId: null,
    revisionId: null,
    previousRevisionId: null,
    createdDocument: false,
    draft: null,
    acl: null,
    error: null,
  });
  const prisma = {
    connector: new Table(),
    connectorRun: new Table(),
    connectorRunItem: new Table(itemDefaults, [['runId', 'externalId']]),
    connectorLink: new Table(() => ({ aclHash: null, aclRestricted: false }), [['connectorId', 'externalId']]),
    connectorConflict: new Table(),
    document: new Table(),
    documentRevision: new Table(),
    documentBranch: new Table(),
    accessGrant: new Table(),
    externalIdentity: new Table(() => ({ userId: null, mappedBy: null, lastSeenAt: new Date() }), [['connectorId', 'externalId']]),
    userGroup: new Table(),
    userGroupMember: new Table(),
    workspaceMember: new Table(),
    withTransaction: async <T>(fn: () => Promise<T>) => fn(),
    onCommit: () => undefined,
  };
  prisma.workspaceMember.rows.push({
    workspaceId: 'ws-1',
    userId: ALICE,
    user: { email: 'alice@acme.test', emailVerifiedAt: new Date() },
  });

  const objects = new Map<string, string>();
  const storage = {
    connectorItemObjectKey: (ws: string, run: string, item: string, name: string) => `${ws}/${run}/${item}/${name}`,
    putObjectText: async (key: string, text: string) => void objects.set(key, text),
    getObjectText: async (key: string) => objects.get(key) ?? '',
  };

  const newRevision = async (documentId: string, branch = 'main') => {
    const rev = await prisma.documentRevision.create({
      data: { documentId, s3Key: `doc/${documentId}/${randomUUID()}.md`, status: 'draft', contentType: 'text/markdown' },
    });
    const existing = await prisma.documentBranch.findUnique({ where: { documentId_name: { documentId, name: branch } } });
    if (existing) await prisma.documentBranch.update({ where: { id: existing.id }, data: { headRevisionId: rev.id } });
    else await prisma.documentBranch.create({ data: { documentId, name: branch, headRevisionId: rev.id } });
    return rev.id as string;
  };
  const documents = {
    createDocument: async (input: Row) => {
      const doc = await prisma.document.create({
        data: { workspaceId: input.workspaceId, title: input.title, parentId: input.parentId ?? null, restricted: false, defaultBranch: 'main' },
      });
      return { documentId: doc.id as string, revisionId: await newRevision(doc.id as string) };
    },
    createRevision: async (documentId: string, input: { branch?: string }) => ({ revisionId: await newRevision(documentId, input.branch) }),
    finalizeRevision: async (_doc: string, revisionId: string) =>
      prisma.documentRevision.update({ where: { id: revisionId }, data: { status: 'indexed' } }),
    createBranch: async () => undefined,
  };

  const settings: Record<string, unknown> = { CONNECTOR_SYNC_MAX_ITEMS: 1000, CONNECTOR_SYNC_BATCH: 50, CONNECTOR_ACL_SYNC_DEFAULT_MIN: 60 };
  const config = { get: (k: string) => settings[k] };
  const connectors = {
    adapterFor: () => adapter,
    contextFor: async () => ctxFor(),
  };
  const acl = new ConnectorAclService(
    prisma as never,
    config as never,
    connectors as never,
    { recomputeRestrictedBy: async () => 1 } as never,
    { changed: async () => undefined } as never,
  );
  const discovery = new ConnectorDiscoveryService(prisma as never, config as never);
  const staging = new ConnectorStagingService(prisma as never, documents as never, storage as never, acl);
  const sync = new ConnectorSyncService(
    prisma as never,
    config as never,
    connectors as never,
    discovery,
    staging,
    documents as never,
    { publish: async () => undefined } as never,
    {} as never,
    {} as never,
  );

  const connectorId = 'conn-1';
  prisma.connector.rows.push({
    id: connectorId,
    workspaceId: 'ws-1',
    kind: 'google-drive',
    name: 'Drive',
    config: { folderId: ROOT },
    projectId: 'proj-1',
    parentId: DEST,
    category: 'other',
    conflict: 'manual',
    preserveHierarchy: true,
    aclMode: options.aclMode ?? 'off',
    aclAudienceGroupId: null,
    createdBy: OWNER,
    changeCursor: null,
    locale: 'en',
  });

  /** One run, start to finish, the way the processor drives it; a reviewed run is approved whole. */
  async function runOnce(trigger: 'manual' | 'schedule' = 'manual') {
    const run = await prisma.connectorRun.create({
      data: {
        connectorId,
        workspaceId: 'ws-1',
        direction: 'pull',
        trigger,
        status: 'running',
        mode: 'review',
        phase: null,
        cursor: null,
        scope: null,
        changeCursor: null,
        warnings: null,
        created: 0,
        updated: 0,
        skipped: 0,
        failed: 0,
        conflicts: 0,
        discovered: 0,
        applied: 0,
      },
    });
    const id = run.id as string;
    const drain = async () => {
      for (let i = 0; i < 100; i += 1) {
        const row = (await prisma.connectorRun.findUnique({ where: { id } }))!;
        if (row.status !== 'running') return;
        const connector = (await prisma.connector.findUnique({ where: { id: connectorId } }))!;
        if ((await sync.run(connector as never, row as never)).done) return;
      }
      throw new Error('run did not settle');
    };
    await drain();
    const parked = (await prisma.connectorRun.findUnique({ where: { id } }))!;
    const staged = await prisma.connectorRunItem.findMany({ where: { runId: id, status: 'staged' } });
    if (parked.status === 'awaiting-review') {
      // APPROVE_ALL, as ConnectorItemsService does it.
      await prisma.connectorRunItem.updateMany({ where: { runId: id, status: 'staged' }, data: { status: 'approved' } });
      await prisma.connectorRun.update({ where: { id }, data: { status: 'running', phase: 'applying' } });
      await drain();
    }
    const items = await prisma.connectorRunItem.findMany({ where: { runId: id }, orderBy: [{ depth: 'asc' }, { position: 'asc' }] });
    return { run: (await prisma.connectorRun.findUnique({ where: { id } }))!, staged, items };
  }

  const pageOf = async (externalId: string) => {
    const link = await prisma.connectorLink.findUnique({ where: { connectorId_externalId: { connectorId, externalId } } });
    return link ? prisma.document.findUnique({ where: { id: link.documentId } }) : null;
  };

  return { prisma, runOnce, pageOf, objects };
}

describe('Google Drive sync', () => {
  it('stages one page per supported file under the folder hierarchy, in review mode', async () => {
    const e = engine();
    const { run, staged, items } = await e.runOnce();

    // Review mode: everything was staged and waited for a person first.
    expect(staged.map((i) => i.externalId).sort()).toEqual(['eng', 'runbook', 'secret', 'welcome']);
    const tree = Object.fromEntries(items.map((i) => [i.externalId, i]));
    expect(tree.runbook.parentItemId).toBe(tree.eng.id);
    expect(tree.secret.parentItemId).toBe(tree.eng.id);
    expect(tree.eng.parentItemId).toBeNull();
    expect(items.some((i) => i.externalId === 'logo')).toBe(false);

    expect(run.status).toBe('succeeded');
    expect(run.created).toBe(4);
    const warnings = run.warnings as Array<{ message: string }>;
    expect(warnings.map((w) => w.message)).toEqual([expect.stringMatching(/logo\.png.*|.*logo\.png/)]);

    // The folder hierarchy survives: files nest under the folder's page, the
    // folder under the connector's destination.
    const eng = await e.pageOf('eng');
    expect(eng?.parentId).toBe(DEST);
    expect((await e.pageOf('runbook'))?.parentId).toBe(eng?.id);
    expect((await e.pageOf('welcome'))?.parentId).toBe(DEST);
    expect([...e.objects.values()].some((md) => md.includes('Restart the thing.'))).toBe(true);
  });

  it('reports every item unchanged when nothing changed upstream', async () => {
    const e = engine();
    await e.runOnce();
    const pages = e.prisma.document.rows.length;

    const second = await e.runOnce();
    expect(second.items.map((i) => i.status)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    expect(second.staged).toEqual([]);
    expect(second.run).toMatchObject({ created: 0, updated: 0, skipped: 4, status: 'succeeded' });
    expect(e.prisma.document.rows.length).toBe(pages);
  });

  it('brings a file restricted in Drive in restricted, with acl_mode = mirror', async () => {
    const e = engine({ aclMode: 'mirror' });
    await e.runOnce();

    const secret = await e.pageOf('secret');
    expect(secret?.restricted).toBe(true);
    expect(e.prisma.accessGrant.rows.filter((g) => g.resourceId === secret?.id)).toEqual([
      expect.objectContaining({ subjectType: 'user', subjectId: ALICE, level: 'edit', origin: 'connector', connectorId: 'conn-1' }),
    ]);
    // Shared with the whole domain: open, as it is upstream.
    expect((await e.pageOf('runbook'))?.restricted).toBe(false);
    // The service account is the reader, not a person anyone should map.
    expect(e.prisma.externalIdentity.rows.map((i) => i.externalId)).toEqual(['alice@acme.test']);
  });

  it('bookmarks the change feed before the walk and advances it only when the run finishes', async () => {
    const e = engine();
    await e.runOnce();
    expect((await e.prisma.connector.findUnique({ where: { id: 'conn-1' } }))?.changeCursor).toBe('100');

    // A scheduled run reads only what changed since the bookmark.
    drive.get('runbook')!.version = '4';
    drive.get('runbook')!.body = '# Runbook\n\nRestart it twice.';
    drive.set('new', {
      id: 'new',
      name: 'New.md',
      mimeType: 'text/markdown',
      version: '1',
      parents: ['eng'],
      size: '10',
      body: 'Fresh.',
      permissions: ORG_WIDE,
    });
    feed = {
      '100': {
        newStartPageToken: '105',
        changes: [
          { changeType: 'file', fileId: 'runbook', file: meta(drive.get('runbook')!) },
          { changeType: 'file', fileId: 'new', file: meta(drive.get('new')!) },
        ],
      },
    };
    const listed = mockFetch.mock.calls.length;
    const { run, items } = await e.runOnce('schedule');
    expect(items.map((i) => i.externalId).sort()).toEqual(['new', 'runbook']);
    expect(run).toMatchObject({ created: 1, updated: 1, status: 'succeeded' });
    // No folder was listed: the feed alone said what to read.
    expect(mockFetch.mock.calls.slice(listed).some(([u]) => new URL(String(u)).pathname === '/drive/v3/files')).toBe(false);
    // A new file in an imported folder lands in that folder's page.
    expect((await e.pageOf('new'))?.parentId).toBe((await e.pageOf('eng'))?.id);
    expect((await e.prisma.connector.findUnique({ where: { id: 'conn-1' } }))?.changeCursor).toBe('105');
  });

  it('keeps the bookmark when a run does not finish', async () => {
    const e = engine();
    await e.runOnce();
    feed = { '100': { newStartPageToken: '200', changes: [] } };
    // A run that dies after discovery never reaches finish().
    const run = await e.prisma.connectorRun.create({
      data: { connectorId: 'conn-1', workspaceId: 'ws-1', direction: 'pull', trigger: 'schedule', status: 'running', mode: 'review', phase: null, cursor: null, discovered: 0, applied: 0, created: 0, updated: 0, skipped: 0, failed: 0, conflicts: 0, warnings: null, scope: null, changeCursor: null },
    });
    const discovery = new ConnectorDiscoveryService(e.prisma as never, { get: () => 1000 } as never);
    const connector = (await e.prisma.connector.findUnique({ where: { id: 'conn-1' } }))!;
    await discovery.step(connector as never, run as never, adapter, ctxFor(), 50);
    expect((await e.prisma.connectorRun.findUnique({ where: { id: run.id } }))?.changeCursor).toBe('200');
    expect((await e.prisma.connector.findUnique({ where: { id: 'conn-1' } }))?.changeCursor).toBe('100');
  });

  it('reports trashed and unshared linked files and keeps their pages', async () => {
    const e = engine();
    await e.runOnce();
    const welcome = await e.pageOf('welcome');

    drive.get('welcome')!.trashed = true;
    const secret = drive.get('secret')!;
    drive.delete('secret');
    feed = {
      '100': {
        newStartPageToken: '110',
        changes: [
          { changeType: 'file', fileId: 'welcome', file: meta({ ...drive.get('welcome')!, trashed: true }) },
          { changeType: 'file', fileId: 'secret', removed: true },
          // Never linked: nothing to say about it.
          { changeType: 'file', fileId: 'stranger', removed: true },
        ],
      },
    };
    const { run, items } = await e.runOnce('schedule');
    const byId = Object.fromEntries(items.map((i) => [i.externalId, i]));
    expect(Object.keys(byId).sort()).toEqual(['secret', 'welcome']);
    expect(byId.welcome).toMatchObject({ status: 'unchanged', documentId: welcome?.id });
    expect((byId.welcome.draft as { warnings: string[] }).warnings[0]).toMatch(/bin/);
    expect((byId.secret.draft as { warnings: string[] }).warnings[0]).toMatch(/unshared/);
    expect((run.warnings as Array<{ message: string }>).map((w) => w.message)).toEqual([expect.stringMatching(/^2 linked page/)]);
    // Nothing was deleted.
    expect(await e.pageOf('welcome')).not.toBeNull();
    expect(await e.pageOf('secret')).not.toBeNull();
    expect(secret.id).toBe('secret');

    // A manual sync walks the tree: the trashed file is not in it, the rest unchanged.
    const manual = await e.runOnce();
    expect(manual.items.every((i) => i.status === 'unchanged')).toBe(true);
  });

  it('walks the whole tree when the stored cursor is refused', async () => {
    const e = engine();
    await e.runOnce();
    await e.prisma.connector.update({ where: { id: 'conn-1' }, data: { changeCursor: 'expired' } });
    startToken = '300';
    const { items } = await e.runOnce('schedule');
    expect(items).toHaveLength(4);
    expect((await e.prisma.connector.findUnique({ where: { id: 'conn-1' } }))?.changeCursor).toBe('300');
  });
});
