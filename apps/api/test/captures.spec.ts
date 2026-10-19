import { describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { CreateCaptureRequest } from '@knowledge/contracts';
import { CaptureService } from '../src/captures/capture.service.js';
import { captureContentHash, decidePage, dedupeText, foldTermKeys, rankSimilar } from '../src/captures/capture-dedupe.js';
import { findSecret } from '../src/captures/secret-scan.js';
import { parseMarkdown } from '../src/common/frontmatter.js';
import type { Principal } from '../src/auth/principal.js';

/**
 * Agent-session captures (issue #73, phase 2). Pinned: a novel capture opens a
 * merge request with provenance `captured` and publishes nothing; the same
 * capture again, or the knowledge base already saying it, proposes nothing;
 * a close page is amended rather than duplicated; limits, secrets, the key's
 * project pin and citations are refused before a row exists; a claim is held
 * by one driver at a time; a term waits in the inbox.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const OTHER_PROJECT = '33333333-3333-4333-8333-333333333333';
const PAGE = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown> & { id: string; createdAt: Date };

/** The where shapes CaptureService emits, over one in-memory row. */
function matches(where: Record<string, unknown>, row: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(w, row));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(w, row));
    const value = row[key] ?? null;
    if (cond === null) return value === null;
    if (cond instanceof Date) return value instanceof Date && value.getTime() === cond.getTime();
    if (typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('not' in c) return value !== null && value !== c.not;
    if ('in' in c) return (c.in as unknown[]).includes(value);
    if ('gt' in c) return value instanceof Date && value > (c.gt as Date);
    if ('lt' in c) return value instanceof Date && value < (c.lt as Date);
    if ('equals' in c) return String(value).toLowerCase() === String(c.equals).toLowerCase();
    throw new Error(`unmodelled where on ${key}`);
  });
}

function harness(opts: {
  similar?: Array<{ documentId: string; title: string; score: number }>;
  enabled?: boolean;
  perKeyPerHour?: number;
  terms?: Array<{ id: string; term: string; aliases: string[] }>;
  relationChanged?: boolean;
  getContent?: () => Promise<unknown>;
} = {}) {
  const captures: Row[] = [];
  let seq = 0;
  const knowledgeCapture = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      const row: Row = {
        id: `cap-${String(++seq).padStart(8, '0')}`,
        status: 'staged',
        outcome: null,
        similar: [],
        targetDocumentId: null,
        mergeRequestId: null,
        glossaryTermId: null,
        error: null,
        claimedAt: null,
        attempts: 0,
        createdAt: new Date(Date.now() + seq),
        updatedAt: new Date(),
        ...data,
      };
      captures.push(row);
      return row;
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => captures.find((r) => matches(where, r)) ?? null),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => captures.filter((r) => matches(where, r))),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => captures.find((r) => r.id === where.id)!),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => captures.filter((r) => matches(where, r)).length),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = captures.filter((r) => matches(where, r));
      for (const r of hit) {
        for (const [k, v] of Object.entries(data)) {
          r[k] = v && typeof v === 'object' && 'increment' in v ? (r[k] as number) + (v as { increment: number }).increment : v;
        }
      }
      return { count: hit.length };
    }),
  };
  const mrStatus = new Map<string, string>();
  const prisma = {
    knowledgeCapture,
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    project: {
      findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ([PROJECT, OTHER_PROJECT].includes(where.id) ? { id: where.id } : null)),
    },
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, title: opts.similar?.find((s) => s.documentId === id)?.title ?? `Page ${id.slice(0, 4)}` })),
      ),
      findFirst: vi.fn(async () => ({ id: PAGE, projectId: PROJECT })),
      findUnique: vi.fn(async () => ({ workspaceId: WS, projectId: PROJECT })),
      update: vi.fn(async () => ({})),
    },
    documentRevision: { findUnique: vi.fn(async () => ({ id: 'rev-1', s3Key: 'k/source.md' })) },
    glossaryTerm: { findMany: vi.fn(async () => opts.terms ?? []) },
    mergeRequest: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, status: mrStatus.get(id) ?? 'open' })),
      ),
    },
  };
  const access = { requireRole: vi.fn(async () => undefined) };
  const scope = { workspaceId: WS, bypass: true, guest: false, denied: new Set<string>(), granted: new Set<string>() };
  const permissions = {
    scopeFor: vi.fn(async () => scope),
    documentFilterFor: vi.fn(async () => ({ kind: 'all' })),
    requireResource: vi.fn(async () => undefined),
  };
  let mrSeq = 0;
  const documents = {
    createDocument: vi.fn(async () => ({ documentId: 'doc-new' })),
    createBranch: vi.fn(async () => ({})),
    createRevision: vi.fn(async () => ({ revisionId: 'rev-1' })),
    finalizeRevision: vi.fn(async () => ({})),
    getContent: vi.fn(
      opts.getContent ?? (async () => ({ markdown: '# Search\n\nHow search works.\n', frontmatter: { tags: ['search'] } })),
    ),
  };
  const mergeRequests = {
    create: vi.fn(async () => ({ mergeRequest: { mergeRequestId: `mr-${++mrSeq}` } })),
  };
  const relations = {
    propose: vi.fn(async (_doc: string, _patch: unknown, _p: Principal, o: { onCreated?: (id: string) => Promise<void> }) => {
      if (opts.relationChanged === false) return { changed: false, mergeRequestId: null };
      await o.onCreated?.('mr-rel');
      return { changed: true, mergeRequestId: 'mr-rel' };
    }),
  };
  const storage = { putObjectText: vi.fn(async () => undefined) };
  const graph = {
    searchChunks: vi.fn(async () => (opts.similar ?? []).map((s) => ({ documentId: s.documentId, score: s.score }))),
  };
  const embeddings = { embed: vi.fn(async () => [1, 0]) };
  const setting = <T>(effective: T) => ({ requested: null, ceiling: effective, effective, source: 'env' });
  const aiConfig = {
    captureSettings: vi.fn(async () => ({
      enabled: setting(opts.enabled ?? true),
      perKeyPerHour: setting(opts.perKeyPerHour ?? 30),
      perWorkspacePerDay: setting(500),
      dedupeThreshold: { requested: null, effective: 0.92, source: 'env' },
      amendThreshold: { requested: null, effective: 0.8, source: 'env' },
      parentDocumentId: null,
    })),
  };
  const activity = { record: vi.fn(async () => undefined) };
  const env: Record<string, unknown> = { WEB_BASE_URL: 'https://kn.test/', CAPTURE_MAX_CHARS: 8000, CAPTURE_STALE_MS: 300_000 };
  const config = { get: (key: string) => env[key] };
  const svc = new CaptureService(
    prisma as never,
    storage as never,
    access as never,
    permissions as never,
    documents as never,
    mergeRequests as never,
    relations as never,
    graph as never,
    embeddings as never,
    aiConfig as never,
    activity as never,
    config as never,
  );
  const written = () => storage.putObjectText.mock.calls.map((c) => parseMarkdown((c as unknown as [string, string])[1]));
  return { svc, captures, prisma, documents, mergeRequests, relations, storage, embeddings, permissions, activity, mrStatus, written };
}

const principal = (projectIds: string[] | null = null): Principal => ({
  userId: 'u-1',
  email: 'u@example.com',
  displayName: 'U',
  avatarUrl: null,
  mode: 'api-key',
  isAdmin: false,
  locale: 'en',
  apiKey: { id: 'key-1', scope: 'capture', workspaceId: null, projectIds },
});

const session = { client: 'claude-code' as const, sessionId: 's-1', repo: 'acme/kb', commit: 'abc123', files: ['src/search.ts'] };

const decision = (over: Partial<Extract<CreateCaptureRequest, { kind: 'decision' }>> = {}): CreateCaptureRequest => ({
  kind: 'decision',
  workspaceId: WS,
  projectId: PROJECT,
  title: 'Fuse vector and BM25 with RRF',
  context: 'Scores from the two legs are not comparable.',
  decision: 'Reciprocal rank fusion with k=60.',
  session,
  ...over,
});

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  const e = err as HttpException;
  return { status: e.getStatus(), body: e.getResponse() as Record<string, unknown> };
}

describe('a novel capture', () => {
  it('opens a merge request with provenance captured on a hidden new page, and publishes nothing', async () => {
    const h = harness();
    const res = await h.svc.capture(decision(), principal());

    expect(res).toMatchObject({ state: 'proposed', outcome: 'new-page', mergeRequestId: 'mr-1', targetDocumentId: 'doc-new' });
    expect(res.webUrl).toBe('https://kn.test/merge-requests/mr-1');
    // Created empty; the body exists only on the capture branch.
    expect(h.documents.createDocument).toHaveBeenCalledWith(
      { workspaceId: WS, projectId: PROJECT, title: 'Fuse vector and BM25 with RRF', category: 'architecture' },
      'u-1',
    );
    expect(h.documents.createBranch).toHaveBeenCalledWith('doc-new', { name: expect.stringMatching(/^capture\/cap-0000/) });
    expect(h.mergeRequests.create).toHaveBeenCalledWith('doc-new', expect.any(Object), 'u-1', {
      provenance: 'captured',
      captureId: h.captures[0].id,
    });
    expect(h.prisma.document.update).toHaveBeenCalledWith({ where: { id: 'doc-new' }, data: { pendingMergeRequestId: 'mr-1' } });

    const [page] = h.written();
    // Headings are message keys here: no i18n service is booted (the catalogues are pinned in capture-templates.spec).
    expect(page.body).toContain('## capture.heading.decision\n\nReciprocal rank fusion with k=60.');
    expect(page.data).toMatchObject({
      source: 'capture:claude-code',
      captured: [{ id: h.captures[0].id, kind: 'decision', client: 'claude-code', sessionId: 's-1', repo: 'acme/kb', commit: 'abc123' }],
    });
    expect(h.captures[0]).toMatchObject({ status: 'proposed', claimedAt: null, apiKeyId: 'key-1', createdBy: 'u-1' });
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'capture.proposed', subjectId: h.captures[0].id }));
  });

  it('a chat capture (#82) keeps its server-set origin on the row, in the description and in sources:', async () => {
    const h = harness();
    const origin = { platform: 'telegram', chatTitle: 'Platform', from: '2026-10-19T10:00:00.000Z', to: '2026-10-19T10:01:00.000Z' };
    await h.svc.capture({ ...decision(), session: { client: 'chat' } }, principal(), { origin });
    expect(h.captures[0]).toMatchObject({ origin });
    const [, mr] = h.mergeRequests.create.mock.calls[0] as unknown as [string, { description: string }];
    expect(mr.description).toMatch(/^capture\.mergeRequest\.introChat/);
    expect(h.written()[0].data).toMatchObject({ source: 'capture:chat', sources: [origin] });
  });

  it('sends the same capture again as a duplicate that opens nothing', async () => {
    const h = harness();
    const first = await h.svc.capture(decision(), principal());
    // Different session, same fact, keys in another order.
    const again = await h.svc.capture({ ...decision(), session: { client: 'cursor' } }, principal());

    expect(again).toMatchObject({ state: 'duplicate', outcome: 'none', mergeRequestId: first.mergeRequestId });
    expect(h.mergeRequests.create).toHaveBeenCalledTimes(1);
    expect(h.captures).toHaveLength(2);
  });

  it('treats a capture under the same title as one still in flight as its duplicate', async () => {
    const h = harness();
    await h.svc.capture(decision(), principal());
    const reworded = await h.svc.capture(decision({ decision: 'RRF, k = 60, both legs over-fetched.' }), principal());
    expect(reworded.state).toBe('duplicate');
    expect(h.mergeRequests.create).toHaveBeenCalledTimes(1);
  });
});

describe('against what already exists', () => {
  it('amends the closest page above the amend threshold, keeping its frontmatter', async () => {
    const h = harness({ similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }] });
    const res = await h.svc.capture(decision(), principal());

    expect(res).toMatchObject({ state: 'proposed', outcome: 'amend-page', targetDocumentId: PAGE });
    expect(res.similar).toEqual([{ documentId: PAGE, title: 'Search', score: 0.86 }]);
    expect(h.documents.createDocument).not.toHaveBeenCalled();
    expect(h.prisma.document.update).not.toHaveBeenCalled();
    const [page] = h.written();
    expect(page.body).toMatch(/^# Search\n\nHow search works\.\n\n## capture\.heading\.captured\n\n### capture\.heading\.context/);
    expect(page.data).toMatchObject({ tags: ['search'], captured: [expect.objectContaining({ kind: 'decision' })] });
  });

  it('starts a page of its own when the close page is one its writer cannot edit', async () => {
    const h = harness({ similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }] });
    (h.svc as unknown as { permissions: { requireResource: ReturnType<typeof vi.fn> } }).permissions.requireResource.mockRejectedValue(
      new Error('no edit'),
    );
    expect((await h.svc.capture(decision(), principal())).outcome).toBe('new-page');
  });

  it('proposes nothing when a page above the duplicate threshold already says it under that title', async () => {
    const h = harness({ similar: [{ documentId: PAGE, title: 'Fuse vector and BM25 with RRF.', score: 0.95 }] });
    const res = await h.svc.capture(decision(), principal());
    expect(res).toMatchObject({ state: 'duplicate', outcome: 'none', targetDocumentId: PAGE, webUrl: `https://kn.test/documents/${PAGE}` });
    expect(h.mergeRequests.create).not.toHaveBeenCalled();
  });
});

describe('knowledge_find_similar predicts the capture (#233)', () => {
  const scope = { workspaceId: WS, bypass: true, guest: false, denied: new Set<string>(), granted: new Set<string>() };
  const d = decision() as Extract<CreateCaptureRequest, { kind: 'decision' }>;
  const probe = { title: `  ${d.title} `, kind: 'decision' as const, text: `${d.context}\n${d.decision}`, projectId: PROJECT };

  it.each([
    ['amend', 'amend-page', [{ documentId: PAGE, title: 'Search', score: 0.86 }]],
    ['duplicate', 'none', [{ documentId: PAGE, title: 'Fuse vector and BM25 with RRF', score: 0.95 }]],
    ['new-page', 'new-page', [{ documentId: PAGE, title: 'Search', score: 0.5 }]],
  ] as const)('embeds what the capture embeds and decides %s where the capture says %s', async (said, outcome, similar) => {
    const h = harness({ similar: [...similar] });
    const res = await h.svc.findSimilar(principal(), scope as never, probe);
    const captured = await h.svc.capture(d, principal());

    const [probed, capturedText] = h.embeddings.embed.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(probed).toBe(capturedText);
    expect(probed).toBe('Fuse vector and BM25 with RRF\n\nScores from the two legs are not comparable.\nReciprocal rank fusion with k=60.');
    expect(res.similar[0]).toEqual(captured.similar[0]);
    expect(res.decision).toBe(said);
    expect(captured.outcome).toBe(outcome);
  });

  it('calls an amendment its writer could not propose a new page, as the capture does', async () => {
    const h = harness({ similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }] });
    h.permissions.requireResource.mockRejectedValue(new Error('no edit'));
    expect((await h.svc.findSimilar(principal(), scope as never, probe)).decision).toBe('new-page');
  });

  it('embeds text alone and decides nothing without a title and kind, as before', async () => {
    const h = harness({ similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }] });
    const res = await h.svc.findSimilar(principal(), scope as never, { text: 'how search fuses scores' });
    expect(h.embeddings.embed).toHaveBeenCalledWith('how search fuses scores');
    expect(res).toEqual({ similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }] });
  });
});

describe('refused before a row exists', () => {
  it('429s past the per-key hourly limit with the retry hint', async () => {
    const h = harness({ perKeyPerHour: 1 });
    await h.svc.capture(decision(), principal());
    const { status, body } = await refusal(h.svc.capture(decision({ title: 'Another decision' }), principal()));
    expect(status).toBe(429);
    expect(body).toMatchObject({ reason: 'capture-rate-limited', per: 'key', limit: 1 });
    expect(body.retryAfterSec).toBeGreaterThan(3500);
    expect(h.captures).toHaveLength(1);
  });

  it('refuses a payload carrying a credential and stores nothing', async () => {
    const h = harness();
    const { status, body } = await refusal(
      h.svc.capture(decision({ context: 'Set OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx in .env' }), principal()),
    );
    expect(status).toBe(400);
    expect(body).toMatchObject({ reason: 'capture-secret', pattern: 'provider-api-key' });
    expect(JSON.stringify(body)).not.toContain('sk-proj');
    expect(h.captures).toHaveLength(0);
  });

  it("refuses a project outside the key's pin", async () => {
    const h = harness();
    const { status, body } = await refusal(h.svc.capture(decision({ projectId: OTHER_PROJECT }), principal([PROJECT])));
    expect(status).toBe(403);
    expect(body).toMatchObject({ reason: 'capture-project-not-allowed' });
    await expect(h.svc.capture(decision(), principal([PROJECT]))).resolves.toMatchObject({ state: 'proposed' });
  });

  it('refuses an answer with no cited page', async () => {
    const h = harness();
    const { status } = await refusal(
      h.svc.capture({ kind: 'answer', workspaceId: WS, question: 'Q?', answer: 'A.', citedDocumentIds: [], session }, principal()),
    );
    expect(status).toBe(400);
  });

  it('refuses everything while the workspace has capture switched off', async () => {
    const h = harness({ enabled: false });
    expect((await refusal(h.svc.capture(decision(), principal()))).status).toBe(403);
  });
});

describe('the claim', () => {
  it('lets one driver propose a staged row; a second finds it held and opens nothing', async () => {
    const h = harness();
    const row = await h.prisma.knowledgeCapture.create({
      data: { workspaceId: WS, projectId: PROJECT, kind: 'decision', title: 'T', payload: decision(), session, createdBy: 'u-1', claimedAt: new Date() },
    });
    const res = await h.svc.drive(row.id, principal());
    expect(res.state).toBe('staged');
    expect(h.mergeRequests.create).not.toHaveBeenCalled();
  });

  it('leaves a transient failure staged and unclaimed for the sweeper, and fails a refusal', async () => {
    const boom = harness({
      similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }],
      getContent: async () => {
        throw new Error('storage down');
      },
    });
    await expect(boom.svc.capture(decision(), principal())).rejects.toThrow('storage down');
    expect(boom.captures[0]).toMatchObject({ status: 'staged', claimedAt: null, attempts: 1, error: 'Error: storage down' });

    const refused = harness({
      similar: [{ documentId: PAGE, title: 'Search', score: 0.86 }],
      getContent: async () => {
        throw new HttpException('archived', 409);
      },
    });
    await expect(refused.svc.capture(decision(), principal())).rejects.toThrow('archived');
    expect(refused.captures[0]).toMatchObject({ status: 'failed', claimedAt: null });
  });
});

describe('terms and relations', () => {
  it('stages a new term in the inbox and opens nothing', async () => {
    const h = harness();
    const res = await h.svc.capture(
      { kind: 'glossary', workspaceId: WS, projectId: PROJECT, term: 'RRF', definition: 'Reciprocal rank fusion.', session },
      principal(),
    );
    expect(res).toMatchObject({ state: 'staged', outcome: 'glossary', mergeRequestId: null, webUrl: null });
    expect(h.captures[0]).toMatchObject({ status: 'staged', outcome: 'glossary', claimedAt: null });
    expect(h.mergeRequests.create).not.toHaveBeenCalled();
    // A term waiting for approval is not the sweeper's to drive again.
    expect((await h.svc.drive(h.captures[0].id, principal())).state).toBe('staged');
    expect(h.captures[0].attempts).toBe(1);
  });

  it('answers a term the project already has under any spelling as a duplicate of it', async () => {
    const h = harness({ terms: [{ id: 'term-1', term: 'Reciprocal rank fusion', aliases: ['rrf'] }] });
    const res = await h.svc.capture(
      { kind: 'glossary', workspaceId: WS, projectId: PROJECT, term: 'RRF', definition: 'Fusion.', session },
      principal(),
    );
    expect(res).toMatchObject({ state: 'duplicate', glossaryTermId: 'term-1' });
  });

  it('proposes a relation through the relations merge request, tagged captured', async () => {
    const h = harness();
    const res = await h.svc.capture(
      { kind: 'relation', workspaceId: WS, documentId: PAGE, type: 'DEPENDS_ON', targetKey: 'service:billing', rationale: 'Calls it.', session },
      principal(),
    );
    expect(res).toMatchObject({ state: 'proposed', outcome: 'relation', mergeRequestId: 'mr-rel', targetDocumentId: PAGE });
    expect(h.relations.propose).toHaveBeenCalledWith(
      PAGE,
      expect.objectContaining({ add: [{ type: 'DEPENDS_ON', target: { type: 'service', key: 'service:billing' } }] }),
      expect.anything(),
      expect.objectContaining({ provenance: 'captured', captureId: h.captures[0].id }),
    );
  });

  it('answers a relation the page already declares as a duplicate', async () => {
    const h = harness({ relationChanged: false });
    const res = await h.svc.capture(
      { kind: 'relation', workspaceId: WS, documentId: PAGE, type: 'DEPENDS_ON', targetKey: 'service:billing', rationale: 'r', session },
      principal(),
    );
    expect(res).toMatchObject({ state: 'duplicate', outcome: 'none', targetDocumentId: PAGE });
  });
});

describe('dedupe helpers', () => {
  it('hashes the same content the same whatever the key order or spacing', () => {
    expect(captureContentHash('decision', 'A  title.', { b: 'x', a: ' y ' })).toBe(captureContentHash('decision', 'a title', { a: 'y', b: 'x' }));
    expect(captureContentHash('decision', 'a', { a: 'y' })).not.toBe(captureContentHash('gotcha', 'a', { a: 'y' }));
  });

  it('keeps each page once, by its best chunk, and drops pages it was not given a title for', () => {
    const titles = new Map([['a', 'A'], ['b', 'B']]);
    expect(rankSimilar([{ documentId: 'a', score: 0.5 }, { documentId: 'a', score: 0.9 }, { documentId: 'b', score: 0.7 }, { documentId: 'x', score: 1 }], titles, 5)).toEqual([
      { documentId: 'a', title: 'A', score: 0.9 },
      { documentId: 'b', title: 'B', score: 0.7 },
    ]);
  });

  it('calls a close page under another title an amendment, not a duplicate', () => {
    const t = { dedupe: 0.92, amend: 0.8 };
    expect(decidePage([{ documentId: 'a', title: 'Search', score: 0.97 }], 'Use RRF', t)).toEqual({ outcome: 'amend-page', targetDocumentId: 'a' });
    expect(decidePage([{ documentId: 'a', title: 'Use RRF', score: 0.97 }], 'use rrf.', t)).toEqual({ outcome: 'none', targetDocumentId: 'a' });
    expect(decidePage([{ documentId: 'a', title: 'Search', score: 0.5 }], 'x', t).outcome).toBe('new-page');
    expect(decidePage([], 'x', t).outcome).toBe('new-page');
  });

  it('embeds a page kind as its title, a blank line and its main text; any other kind as its title', () => {
    expect(dedupeText('Use RRF', 'gotcha', 'Scores differ.')).toBe('Use RRF\n\nScores differ.');
    expect(dedupeText('Use RRF', 'glossary', 'Scores differ.')).toBe('Use RRF');
  });

  it('folds a term and its aliases the way entity keys fold', () => {
    expect(foldTermKeys(' RRF ', ['Reciprocal  Rank Fusion'])).toEqual(new Set(['rrf', 'reciprocal-rank-fusion']));
  });
});

describe('findSecret', () => {
  it('names the credential shape and never echoes it', () => {
    expect(findSecret(['token ghp_abcdefghijklmnopqrstuvwxyz0123456789'])).toBe('github-token');
    expect(findSecret(['AKIAABCDEFGHIJKLMNOP'])).toBe('aws-access-key');
    expect(findSecret(['-----BEGIN OPENSSH PRIVATE KEY-----'])).toBe('private-key');
    expect(findSecret(['kn_0123456789abcdefghijklmn'])).toBe('knowledge-api-key');
  });

  it('lets ordinary prose and code through', () => {
    expect(findSecret(['Use sk- prefixed keys from the vault; see task-runner.ts and AKIA docs.'])).toBeNull();
  });
});

describe("a page's first merge request", () => {
  it('diffs against nothing: every line added, frontmatter keys added, no from revision', async () => {
    const { CompareService } = await import('../src/documents/compare.service.js');
    const text = "---\nsource: capture:cursor\n---\n## Context\n\nWhy.\n";
    const prisma = {
      documentRevision: {
        findUnique: vi.fn(async () => ({
          id: 'rev-src',
          documentId: 'doc-new',
          revisionNumber: 1,
          contentHash: 'h',
          contentType: 'text/markdown',
          s3Key: 'k',
          branch: { name: 'capture/x' },
        })),
      },
      document: { findUnique: vi.fn(async () => ({ kind: 'page' })) },
    };
    const storage = { getObjectText: vi.fn(async () => text) };
    const compare = new CompareService(prisma as never, storage as never, {} as never, {} as never);
    const res = await compare.compareWithNothing('doc-new', 'rev-src', { structural: true });
    expect(res.from).toBeNull();
    expect(res.to).toMatchObject({ revisionId: 'rev-src', branch: 'capture/x' });
    expect(res.summary).toEqual({ additions: 6, deletions: 0 });
    expect(res.hunks.flatMap((h) => h.lines).every((l) => l.kind === 'added')).toBe(true);
    expect(res.structural?.summary).toMatchObject({ added: 1, removed: 0, changed: 0 });
    // A page carries no API diff (#78); only a spec does.
    expect(res).not.toHaveProperty('api');
  });
});
