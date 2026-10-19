import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, HttpException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { captureStateFor } from '@knowledge/contracts';
import { ACCESS_META, type AccessSpec } from '../src/auth/access.decorator.js';
import { DEV_PRINCIPAL, type Principal } from '../src/auth/principal.js';
import { CAPTURE_MAX_ATTEMPTS } from '../src/captures/capture.service.js';
import { CaptureInboxService, stripCiteLabels } from '../src/captures/capture-inbox.service.js';
import { CaptureSweeper } from '../src/captures/capture.sweeper.js';
import { AssistantCaptureController, CapturesController } from '../src/captures/captures.controller.js';
import { CreateCaptureDto, toCaptureRequest } from '../src/captures/captures.dto.js';

/**
 * Agent-session captures, phase 3 (issue #73): the inbox and the sweeper.
 * Pinned: only a staged term is approved here, once, as a `captured` glossary
 * entry; a proposed capture is turned down through its merge request, not the
 * inbox; a crash-stranded row is driven again as its writer while a waiting
 * term is left alone; a capture key may create but never decide; an
 * assistant reply is written back with its question and page sources.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const PAGE = '44444444-4444-4444-8444-444444444444';
const OLD = new Date(Date.now() - 3_600_000);

type Row = Record<string, unknown> & { id: string };

function row(over: Partial<Row> & { id: string }): Row {
  return {
    workspaceId: WS,
    projectId: PROJECT,
    kind: 'glossary',
    status: 'staged',
    outcome: 'glossary',
    title: 'RRF',
    payload: { term: 'RRF', definition: 'Reciprocal rank fusion', aliases: ['rank fusion'] },
    session: { client: 'claude-code' },
    similar: [],
    targetDocumentId: null,
    mergeRequestId: null,
    glossaryTermId: null,
    apiKeyId: null,
    createdBy: 'u-1',
    error: null,
    claimedAt: null,
    attempts: 0,
    createdAt: OLD,
    updatedAt: OLD,
    ...over,
  };
}

/** The where shapes the inbox emits, over one in-memory row. */
function matches(where: Record<string, unknown>, r: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as Record<string, unknown>[]).every((w) => matches(w, r));
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((w) => matches(w, r));
    const value = r[key] ?? null;
    if (cond === null) return value === null;
    if (typeof cond !== 'object') return value === cond;
    const c = cond as Record<string, unknown>;
    if ('not' in c) return value !== null && value !== c.not;
    if ('lt' in c) return value instanceof Date && value < (c.lt as Date);
    if ('in' in c) return (c.in as unknown[]).includes(value);
    throw new Error(`unmodelled where on ${key}`);
  });
}

type Key = { id: string; userId: string; workspaceId: string | null; name: string; prefix: string; revokedAt: Date | null };
type Mr = { id: string; documentId: string; status: string };

function harness(
  rows: Row[],
  opts: {
    ownerDisabled?: boolean;
    drive?: (id: string) => Promise<{ state: string }>;
    keys?: Key[];
    members?: string[];
    mrs?: Mr[];
    /** Pages the caller may read but not edit. */
    readOnly?: string[];
    /** The workspace role `requireRole` lets through. */
    role?: 'viewer' | 'editor';
  } = {},
) {
  const mrs = opts.mrs ?? [];
  const knowledgeCapture = {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
    findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id)!),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(where, r))),
    updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const hit = rows.filter((r) => matches(where, r));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) =>
      Object.assign(rows.find((r) => r.id === where.id)!, data),
    ),
    count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(where, r)).length),
  };
  const messages = [
    { id: 'm-q', threadId: 't-1', role: 'user', content: 'How is search fused?', createdAt: OLD },
    {
      id: 'm-a',
      threadId: 't-1',
      role: 'assistant',
      content: 'Vector and BM25 are fused with RRF [S1]. The constant is 60 [S2].',
      sources: [
        { documentId: PAGE, title: 'Search' },
        { kind: 'web', url: 'https://example.com', title: 'RRF paper' },
      ],
      createdAt: new Date(OLD.getTime() + 1),
      thread: { id: 't-1', workspaceId: WS },
    },
  ];
  const prisma = {
    knowledgeCapture,
    withTransaction: vi.fn(async (fn: () => Promise<unknown>) => fn()),
    document: {
      count: vi.fn(async () => 1),
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id }))),
    },
    user: { findUnique: vi.fn(async () => ({ locale: 'ru' })) },
    apiKey: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => (opts.keys ?? []).find((k) => k.id === where.id) ?? null) },
    workspaceMember: {
      count: vi.fn(async ({ where }: { where: { userId: string } }) => ((opts.members ?? ['u-1', 'u-2']).includes(where.userId) ? 1 : 0)),
    },
    mergeRequest: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; status: string } }) =>
        mrs.filter((m) => where.id.in.includes(m.id) && m.status === where.status),
      ),
    },
    assistantMessage: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => messages.find((m) => m.id === where.id) ?? null),
      findFirst: vi.fn(async () => messages[0]),
    },
  };
  const captures = {
    info: vi.fn(async (r: Row) => ({ captureId: r.id, state: captureStateFor(r.status as never, null, r.glossaryTermId as string | null) })),
    capture: vi.fn(async () => ({ captureId: 'c-new', state: 'proposed' })),
    drive: vi.fn(opts.drive ?? (async () => ({ state: 'proposed' }))),
  };
  const access = {
    principalFor: vi.fn(async (userId: string, locale: string) => {
      if (opts.ownerDisabled) throw new Error('runOwnerUnavailable');
      return { ...DEV_PRINCIPAL, userId, locale, mode: 'api-key' };
    }),
    requireRole: vi.fn(async (_p: Principal, _ws: string, role: string) => {
      if (role === 'editor' && (opts.role ?? 'editor') !== 'editor') throw new ForbiddenException('editor required');
    }),
  };
  const scope = { workspaceId: WS, bypass: false, guest: false, denied: new Set<string>(), granted: new Set<string>() };
  const permissions = {
    scopeFor: vi.fn(async () => scope),
    levelFor: vi.fn(async (_s: unknown, r: { id: string }) => ((opts.readOnly ?? []).includes(r.id) ? 'view' : 'edit')),
  };
  const mergeRequests = {
    close: vi.fn(async (id: string) => {
      const mr = mrs.find((m) => m.id === id)!;
      if (mr.status !== 'open') throw new BadRequestException('not open');
      mr.status = 'closed';
      return { mergeRequest: mr };
    }),
  };
  const glossary = { create: vi.fn(async () => ({ termId: 'term-1' })) };
  const activity = { record: vi.fn(async () => undefined) };
  const config = { get: (key: string) => ({ CAPTURE_STALE_MS: 300_000 })[key] };
  const inbox = new CaptureInboxService(
    prisma as never,
    captures as never,
    access as never,
    permissions as never,
    glossary as never,
    activity as never,
    mergeRequests as never,
    config as never,
  );
  return { inbox, rows, prisma, captures, access, scope, glossary, activity, mergeRequests, mrs };
}

const editor: Principal = { ...DEV_PRINCIPAL, userId: 'u-2', mode: 'api-key' };

async function refusal(p: Promise<unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HttpException) return { status: err.getStatus(), body: err.getResponse() as Record<string, unknown> };
    throw err;
  }
  throw new Error('expected a refusal');
}

describe('approving a term', () => {
  it('creates a captured glossary entry as the approver and reads merged after', async () => {
    const h = harness([row({ id: 'c-1' })]);
    const info = await h.inbox.approve('c-1', editor);

    expect(h.glossary.create).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: PROJECT, term: 'RRF', aliases: ['rank fusion'], source: 'captured' }),
      'u-2',
    );
    expect(h.rows[0]).toMatchObject({ status: 'proposed', glossaryTermId: 'term-1' });
    expect(info.state).toBe('merged');
    expect(h.activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'capture.approved', actor: 'u-2' }));
  });

  it('approves once: a second approve finds nothing staged', async () => {
    const h = harness([row({ id: 'c-1' })]);
    await h.inbox.approve('c-1', editor);
    const second = await refusal(h.inbox.approve('c-1', editor));
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ reason: 'capture-not-staged', state: 'merged' });
    expect(h.glossary.create).toHaveBeenCalledTimes(1);
  });

  it('refuses a page capture: its merge request is where it is approved', async () => {
    const h = harness([row({ id: 'c-1', kind: 'decision', status: 'proposed', outcome: 'new-page', mergeRequestId: 'mr-1' })]);
    expect((await refusal(h.inbox.approve('c-1', editor))).body).toMatchObject({ reason: 'capture-not-approvable' });
  });

  it('refuses a term whose dedupe is still running', async () => {
    const h = harness([row({ id: 'c-1', outcome: null, claimedAt: new Date() })]);
    expect((await refusal(h.inbox.approve('c-1', editor))).body).toMatchObject({ reason: 'capture-in-flight' });
    expect(h.glossary.create).not.toHaveBeenCalled();
  });

  it('404s a capture in a project kept from the caller, without saying more', async () => {
    const h = harness([row({ id: 'c-1' })]);
    h.scope.denied.add(PROJECT);
    expect((await refusal(h.inbox.approve('c-1', editor))).status).toBe(404);
  });
});

describe('rejecting', () => {
  it('turns down a staged term', async () => {
    const h = harness([row({ id: 'c-1' })]);
    const info = await h.inbox.reject('c-1', editor, 'Not our term');
    expect(info.state).toBe('rejected');
    expect(h.activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'capture.rejected', metadata: expect.objectContaining({ reason: 'Not our term' }) }),
    );
  });

  it('points a proposed capture at its merge request instead', async () => {
    const h = harness([row({ id: 'c-1', kind: 'decision', status: 'proposed', outcome: 'new-page', mergeRequestId: 'mr-1' })]);
    const r = await refusal(h.inbox.reject('c-1', editor));
    expect(r.status).toBe(409);
    expect(r.body).toMatchObject({ reason: 'capture-use-merge-request', mergeRequestId: 'mr-1' });
    expect(h.rows[0]!.status).toBe('proposed');
  });

  it('does not race a capture someone is proposing right now', async () => {
    const h = harness([row({ id: 'c-1', kind: 'gotcha', outcome: null, claimedAt: new Date() })]);
    expect((await refusal(h.inbox.reject('c-1', editor))).body).toMatchObject({ reason: 'capture-in-flight' });
    expect(h.rows[0]!.status).toBe('staged');
  });
});

describe('the sweeper', () => {
  it('drives a stranded row again as its writer, in their language, and leaves a waiting term alone', async () => {
    const h = harness([
      row({ id: 'c-stranded', kind: 'gotcha', outcome: null }),
      row({ id: 'c-dead-claim', kind: 'decision', outcome: null, claimedAt: OLD, attempts: 1 }),
      row({ id: 'c-term' }),
      row({ id: 'c-fresh', kind: 'howto', outcome: null, updatedAt: new Date() }),
    ]);
    expect(await h.inbox.sweepStranded()).toBe(2);
    expect(h.captures.drive.mock.calls.map((c) => c[0])).toEqual(['c-stranded', 'c-dead-claim']);
    expect(h.access.principalFor).toHaveBeenCalledWith('u-1', 'ru');
  });

  it('fails a row out of attempts, and one whose writer can no longer act, without driving it', async () => {
    const out = harness([row({ id: 'c-1', kind: 'gotcha', outcome: null, attempts: CAPTURE_MAX_ATTEMPTS, error: 'boom' })]);
    expect(await out.inbox.sweepStranded()).toBe(1);
    expect(out.rows[0]).toMatchObject({ status: 'failed', error: 'boom' });
    expect(out.captures.drive).not.toHaveBeenCalled();

    const gone = harness([row({ id: 'c-2', kind: 'gotcha', outcome: null })], { ownerDisabled: true });
    expect(await gone.inbox.sweepStranded()).toBe(1);
    expect(gone.rows[0]!.status).toBe('failed');
  });

  it('keeps going past a row that fails to propose, and never runs two sweeps at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness([row({ id: 'c-1', kind: 'gotcha', outcome: null }), row({ id: 'c-2', kind: 'howto', outcome: null })], {
      drive: async (id) => {
        await gate;
        if (id === 'c-1') throw new Error('graph down');
        return { state: 'proposed' };
      },
    });
    const sweeper = new CaptureSweeper(h.inbox, { get: () => 60_000 } as never);
    const first = sweeper.sweep();
    await sweeper.sweep(); // returns at once: the first is still running
    release();
    await first;
    expect(h.captures.drive).toHaveBeenCalledTimes(2);
  });
});

describe('saving an assistant reply', () => {
  it('writes an answer capture from the question before it and its page sources', async () => {
    const h = harness([]);
    await h.inbox.fromAssistantMessage('m-a', { title: 'Search fusion' }, editor);
    expect(h.captures.capture).toHaveBeenCalledWith(
      {
        kind: 'answer',
        workspaceId: WS,
        title: 'Search fusion',
        question: 'How is search fused?',
        answer: 'Vector and BM25 are fused with RRF. The constant is 60.',
        citedDocumentIds: [PAGE],
        session: { client: 'assistant', sessionId: 't-1' },
      },
      editor,
      {},
    );
  });

  it('refuses a user turn', async () => {
    const h = harness([]);
    expect((await refusal(h.inbox.fromAssistantMessage('m-q', {}, editor))).body).toMatchObject({ reason: 'capture-not-assistant' });
  });

  it('drops the per-turn cite labels a page could not resolve', () => {
    expect(stripCiteLabels('A [S1][S2]. B [S10].')).toBe('A. B.');
  });
});

describe('the routes', () => {
  const spec = (proto: object, method: string) => Reflect.getMetadata(ACCESS_META, (proto as Record<string, object>)[method]!) as AccessSpec;

  it('let a capture key create and save, and never approve or reject', () => {
    expect(spec(CapturesController.prototype, 'create')).toMatchObject({ role: 'editor', source: 'body', capture: true });
    expect(spec(AssistantCaptureController.prototype, 'capture')).toMatchObject({ role: 'editor', source: 'assistant-message', capture: true });
    for (const m of ['approve', 'reject']) {
      expect(spec(CapturesController.prototype, m)).toMatchObject({ role: 'editor', source: 'capture' });
      expect(spec(CapturesController.prototype, m).capture).toBeUndefined();
    }
    expect(spec(CapturesController.prototype, 'get')).toMatchObject({ role: 'viewer', source: 'capture' });
  });

  it('keep bulk reject an editor decision a capture key cannot make', () => {
    expect(spec(CapturesController.prototype, 'bulkReject')).toMatchObject({ role: 'editor', source: 'body' });
    expect(spec(CapturesController.prototype, 'bulkReject').capture).toBeUndefined();
  });

  it("declare bulk-reject before ':id', so Nest never reads it as a capture id", () => {
    const methods = Object.getOwnPropertyNames(CapturesController.prototype);
    expect(methods.indexOf('bulkReject')).toBeLessThan(methods.indexOf('get'));
  });
});

const KEY = '55555555-5555-4555-8555-555555555555';
const OTHER_WS = '66666666-6666-4666-8666-666666666666';
const agentKey = (over: Partial<Key> = {}): Key => ({
  id: KEY,
  userId: 'u-1',
  workspaceId: null,
  name: 'claude-code laptop',
  prefix: 'kn_1a2b3c4d',
  revokedAt: null,
  ...over,
});
const viewer: Principal = { ...DEV_PRINCIPAL, userId: 'u-3', mode: 'api-key' };

describe('narrowing the inbox to one key', () => {
  it("names another person's key for an editor, never its hash", async () => {
    const h = harness([], { keys: [agentKey({ revokedAt: OLD })] });
    expect(await h.inbox.keyIn(WS, KEY, editor)).toEqual({ id: KEY, name: 'claude-code laptop', prefix: 'kn_1a2b3c4d', revoked: true });
  });

  it("refuses a viewer another person's key, and lets them look up their own", async () => {
    const h = harness([], { keys: [agentKey()], members: ['u-1', 'u-3'], role: 'viewer' });
    expect((await refusal(h.inbox.keyIn(WS, KEY, viewer))).status).toBe(403);
    expect((await h.inbox.keyIn(WS, KEY, { ...viewer, userId: 'u-1' })).id).toBe(KEY);
  });

  it("403s another tenant's key and an unknown one alike", async () => {
    const pinned = harness([], { keys: [agentKey({ workspaceId: OTHER_WS })] });
    expect((await refusal(pinned.inbox.keyIn(WS, KEY, editor))).status).toBe(403);
    const stranger = harness([], { keys: [agentKey({ userId: 'u-9' })] });
    expect((await refusal(stranger.inbox.keyIn(WS, KEY, editor))).status).toBe(403);
    expect((await refusal(stranger.inbox.keyIn(WS, '77777777-7777-4777-8777-777777777777', editor))).status).toBe(403);
  });

  it('still finds the key of an owner who has left, through what it captured here', async () => {
    const h = harness([row({ id: 'c-1', apiKeyId: KEY })], { keys: [agentKey({ userId: 'u-9' })] });
    expect((await h.inbox.keyIn(WS, KEY, editor)).id).toBe(KEY);
  });

  it('the list route checks the key before it narrows, and names it in the answer', async () => {
    const captures = { list: vi.fn(async () => ({ captures: [], nextCursor: null })) };
    const inbox = { keyIn: vi.fn(async () => ({ id: KEY, name: 'k', prefix: 'kn_x', revoked: false })) };
    const permissions = { scopeFor: vi.fn(async () => ({})) };
    const controller = new CapturesController(captures as never, inbox as never, permissions as never);
    const res = await controller.list({ workspaceId: WS, apiKeyId: KEY }, editor);
    expect(inbox.keyIn).toHaveBeenCalledWith(WS, KEY, editor);
    expect(captures.list).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: KEY }), expect.anything());
    expect(res.apiKey?.id).toBe(KEY);
  });
});

describe("bulk-rejecting a key's pending captures", () => {
  const PAGE_B = '88888888-8888-4888-8888-888888888888';
  const setup = () =>
    harness(
      [
        row({ id: 'c-term', apiKeyId: KEY }),
        row({ id: 'c-busy', apiKeyId: KEY, kind: 'gotcha', outcome: null, claimedAt: new Date() }),
        row({ id: 'c-open', apiKeyId: KEY, kind: 'decision', status: 'proposed', outcome: 'new-page', mergeRequestId: 'mr-1', targetDocumentId: PAGE }),
        row({ id: 'c-merged', apiKeyId: KEY, kind: 'howto', status: 'proposed', outcome: 'new-page', mergeRequestId: 'mr-2' }),
        row({ id: 'c-locked', apiKeyId: KEY, kind: 'gotcha', status: 'proposed', outcome: 'amend-page', mergeRequestId: 'mr-3', targetDocumentId: PAGE_B }),
        row({ id: 'c-other', apiKeyId: null }),
      ],
      {
        keys: [agentKey()],
        mrs: [
          { id: 'mr-1', documentId: PAGE, status: 'open' },
          { id: 'mr-2', documentId: PAGE, status: 'merged' },
          { id: 'mr-3', documentId: PAGE_B, status: 'open' },
        ],
        readOnly: [PAGE_B],
      },
    );

  it('rejects the staged, closes the open, leaves the merged, and counts what it skipped', async () => {
    const h = setup();
    const res = await h.inbox.bulkReject({ workspaceId: WS, apiKeyId: KEY, reason: 'Looping agent' }, editor);

    expect(res).toEqual({ rejected: 1, closed: 1, skippedInFlight: 1, skippedNoAccess: 1 });
    const status = (id: string) => h.rows.find((r) => r.id === id)!.status;
    expect(status('c-term')).toBe('rejected');
    expect(status('c-busy')).toBe('staged');
    expect(status('c-other')).toBe('staged');
    expect(h.mergeRequests.close).toHaveBeenCalledTimes(1);
    expect(h.mergeRequests.close).toHaveBeenCalledWith('mr-1', 'u-2');
    expect(h.mrs.map((m) => m.status)).toEqual(['closed', 'merged', 'open']);
  });

  it('records each affected capture on its own, marked bulk', async () => {
    const h = setup();
    await h.inbox.bulkReject({ workspaceId: WS, apiKeyId: KEY, reason: 'Looping agent' }, editor);
    const recorded = h.activity.record.mock.calls.map(([e]) => e as { action: string; subjectId: string; metadata: Record<string, unknown> });
    expect(recorded.map((e) => e.subjectId).sort()).toEqual(['c-open', 'c-term']);
    for (const e of recorded) {
      expect(e.action).toBe('capture.rejected');
      expect(e.metadata).toMatchObject({ bulk: true, apiKeyId: KEY, reason: 'Looping agent' });
    }
  });

  it('counts the same rows on a dry run and changes nothing', async () => {
    const h = setup();
    const res = await h.inbox.bulkReject({ workspaceId: WS, apiKeyId: KEY, dryRun: true }, editor);
    expect(res).toEqual({ rejected: 1, closed: 1, skippedInFlight: 1, skippedNoAccess: 1 });
    expect(h.prisma.knowledgeCapture.updateMany).not.toHaveBeenCalled();
    expect(h.mergeRequests.close).not.toHaveBeenCalled();
    expect(h.activity.record).not.toHaveBeenCalled();
  });

  it('leaves out what the caller cannot see in the list, without counting it', async () => {
    const h = setup();
    h.scope.denied.add(PROJECT);
    expect(await h.inbox.bulkReject({ workspaceId: WS, apiKeyId: KEY }, editor)).toEqual({
      rejected: 0,
      closed: 0,
      skippedInFlight: 0,
      skippedNoAccess: 0,
    });
  });

  it("403s another tenant's key before touching anything", async () => {
    const h = harness([row({ id: 'c-1', apiKeyId: KEY })], { keys: [agentKey({ workspaceId: OTHER_WS })] });
    expect((await refusal(h.inbox.bulkReject({ workspaceId: WS, apiKeyId: KEY }, editor))).status).toBe(403);
    expect(h.rows[0]!.status).toBe('staged');
  });
});

describe('POST /v1/captures body', () => {
  const session = { client: 'cursor' };
  const errorsOf = async (body: object) =>
    (await validate(plainToInstance(CreateCaptureDto, body), { whitelist: true })).map((e) => e.property);

  it("requires each kind's own fields and only those", async () => {
    expect(await errorsOf({ workspaceId: WS, kind: 'decision', projectId: PROJECT, title: 'T', session })).toEqual(['context', 'decision']);
    expect(await errorsOf({ workspaceId: WS, kind: 'relation', documentId: PAGE, type: 'DEPENDS_ON', targetKey: 'service:x', rationale: 'r', session })).toEqual([]);
    expect(await errorsOf({ workspaceId: WS, kind: 'answer', question: 'q', answer: 'a', citedDocumentIds: [], session })).toEqual(['citedDocumentIds']);
    expect(await errorsOf({ workspaceId: WS, kind: 'gotcha', title: 'T', body: 'b', session })).toEqual(['projectId']);
    expect(await errorsOf({ workspaceId: WS, kind: 'gotcha', projectId: PROJECT, title: 'T', body: 'b', session: { client: 'vim' } })).toEqual(['session']);
  });

  it("hands the service one kind's fields", () => {
    const dto = plainToInstance(CreateCaptureDto, {
      workspaceId: WS,
      kind: 'howto',
      projectId: PROJECT,
      title: 'Run the backtest',
      body: 'make backtest',
      term: 'stray',
      session,
    });
    expect(toCaptureRequest(dto)).toEqual({
      workspaceId: WS,
      kind: 'howto',
      projectId: PROJECT,
      title: 'Run the backtest',
      body: 'make backtest',
      session,
    });
  });
});

describe('captureStateFor', () => {
  it('reads an approved term as merged, and a duplicate pointing at a term as a duplicate', () => {
    expect(captureStateFor('proposed', null, 'term-1')).toBe('merged');
    expect(captureStateFor('duplicate', null, 'term-1')).toBe('duplicate');
    expect(captureStateFor('proposed', 'open', 'term-1')).toBe('proposed');
  });
});
