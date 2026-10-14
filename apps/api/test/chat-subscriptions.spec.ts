import { describe, expect, it, vi } from 'vitest';
import { chatActionsFor, chatEventKindFor } from '@knowledge/contracts';
import {
  ChatSubscriptionsService,
  COMMIT_LAG_MS,
  INDEX_WAIT_MS,
  foldTags,
} from '../src/chat/chat-subscriptions.service.js';
import { TelegramAdapter } from '../src/chat/adapters/telegram.adapter.js';
import type { ChatView } from '../src/chat/adapters/chat-adapter.types.js';

/**
 * Channel notifications (issue #71, phase 3). What is pinned: the cursor
 * never sends a row twice — not across two sweeps, not across a restart — and
 * never steps over one, including a tagged page still indexing; a refused
 * send puts it back; the tag filter asks the graph inside the rule's own
 * workspace; and what reaches the group is a title and a link, never content.
 */

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-15T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ZERO = '00000000-0000-0000-0000-000000000000';

interface Row {
  id: string;
  workspaceId: string;
  projectId: string | null;
  action: string;
  documentId: string | null;
  subjectId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const row = (n: number, over: Partial<Row>): Row => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  workspaceId: WS,
  projectId: 'p-1',
  action: 'revision.finalized',
  documentId: 'd-1',
  subjectId: `rev-${n}`,
  metadata: {},
  createdAt: ago(60_000 - n * 1000),
  ...over,
});

interface Rev {
  id: string;
  documentId: string;
  branchId: string | null;
  status: string;
  branch: { name: string } | null;
  document: { defaultBranch: string };
}

const rev = (id: string, documentId: string, over: Partial<Rev> = {}): Rev => ({
  id,
  documentId,
  branchId: 'b-main',
  status: 'indexed',
  branch: { name: 'main' },
  document: { defaultBranch: 'main' },
  ...over,
});

function harness(opts: {
  rows: Row[];
  revisions?: Rev[];
  /** The earliest non-draft revision per page, i.e. the one that published it. */
  firsts?: Array<{ id: string; documentId: string; branchId: string | null }>;
  merged?: string[];
  docs?: Array<{ id: string; title: string; workspaceId?: string; archived?: boolean }>;
  tagged?: string[];
  sub?: Partial<{ tags: string[]; eventKinds: string[]; delivery: string; digestMinutes: number | null; projectId: string | null }>;
  sendFails?: boolean;
}) {
  const stored = {
    id: 'sub-1',
    bindingId: 'bind-1',
    workspaceId: WS,
    projectId: 'p-1' as string | null,
    tags: [] as string[],
    eventKinds: ['page-published', 'page-updated', 'merge-request-opened', 'merge-request-merged'] as string[],
    delivery: 'instant',
    digestMinutes: null as number | null,
    cursorAt: ago(120_000),
    cursorId: ZERO,
    nextDueAt: null as Date | null,
    lastDeliveredAt: null as Date | null,
    lastError: null as string | null,
    createdAt: ago(3_600_000),
    ...opts.sub,
  };
  const snapshot = () => ({
    ...stored,
    binding: {
      id: 'bind-1',
      externalChatId: '-100123',
      locale: null,
      integration: { id: 'int-1', kind: 'telegram', locale: 'en', enabled: true, botUsername: 'kn_bot' },
    },
  });

  type Where = {
    workspaceId: string;
    projectId?: string;
    action: { in: string[] };
    AND: [
      { createdAt: { gt: Date; lte: Date } },
      { OR: [{ createdAt: { gt: Date } }, { createdAt: Date; id: { gt: string } }] },
    ];
  };
  const reads: Where[] = [];
  const prisma = {
    activityLog: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        reads.push(where);
        const [window, cursor] = where.AND;
        const after = cursor.OR[1];
        return opts.rows
          .filter((r) => r.workspaceId === where.workspaceId)
          .filter((r) => !where.projectId || r.projectId === where.projectId)
          .filter((r) => where.action.in.includes(r.action))
          .filter((r) => r.createdAt > window.createdAt.gt && r.createdAt <= window.createdAt.lte)
          .filter(
            (r) =>
              r.createdAt > cursor.OR[0].createdAt.gt ||
              (r.createdAt.getTime() === after.createdAt.getTime() && r.id > after.id.gt),
          )
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
      }),
    },
    documentRevision: {
      findMany: vi.fn(async (args: { distinct?: string[] }) => (args.distinct ? (opts.firsts ?? []) : (opts.revisions ?? []))),
    },
    mergeRequest: { findMany: vi.fn(async () => (opts.merged ?? []).map((id) => ({ mergedRevisionId: id }))) },
    document: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; workspaceId: string } }) =>
        (opts.docs ?? [{ id: 'd-1', title: 'Billing runbook' }])
          .filter((d) => where.id.in.includes(d.id) && (d.workspaceId ?? WS) === where.workspaceId && !d.archived)
          .map(({ id, title }) => ({ id, title })),
      ),
    },
    project: { findUnique: vi.fn(async () => ({ name: 'Payments' })) },
    workspace: { findUnique: vi.fn(async () => ({ name: 'Acme' })) },
    chatSubscription: {
      // Guarded exactly as Postgres would: every `where` field must still match.
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const matches = Object.entries(where).every(([k, v]) => {
          const cur = (stored as Record<string, unknown>)[k];
          return v instanceof Date && cur instanceof Date ? v.getTime() === cur.getTime() : v === cur;
        });
        if (!matches) return { count: 0 };
        Object.assign(stored, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(stored, data)),
    },
  };
  const graph = { getDocumentIdsByTags: vi.fn(async () => new Set(opts.tagged ?? [])) };
  const sent: ChatView[] = [];
  const adapter = {
    render: (view: ChatView) => ({ text: '', plain: '', buttons: [], view }),
    postMessage: vi.fn(async (_c: unknown, target: { chatId: string }, msg: { view: ChatView }) => {
      if (opts.sendFails) throw new Error('Forbidden: bot was kicked from the group chat');
      sent.push(msg.view);
      return { chatId: target.chatId, messageId: String(sent.length) };
    }),
  };
  const svc = new ChatSubscriptionsService(
    prisma as never,
    graph as never,
    { get: () => adapter } as never,
    { context: () => ({ token: 'T', botUsername: 'kn_bot' }) } as never,
    { get: (key: string) => ({ WEB_BASE_URL: 'https://kn.test/' })[key] } as never,
  );
  return { svc, stored, snapshot, sent, reads, prisma, graph, adapter };
}

describe('chat event vocabulary', () => {
  it('reads a page only on its default branch, and its first revision there as published', () => {
    expect(chatEventKindFor('revision.finalized', { onDefaultBranch: true, first: true })).toBe('page-published');
    expect(chatEventKindFor('revision.finalized', { onDefaultBranch: true, first: false })).toBe('page-updated');
    expect(chatEventKindFor('revision.finalized', { onDefaultBranch: false, first: true })).toBeNull();
    expect(chatEventKindFor('merge-request.merged', null)).toBe('merge-request-merged');
    expect(chatEventKindFor('merge-request.comment.created', null)).toBeNull();
  });

  it('inverts to the actions the sweeper filters on in SQL', () => {
    expect(chatActionsFor(['page-published', 'page-updated'])).toEqual(['revision.finalized']);
    expect(chatActionsFor(['merge-request-opened', 'merge-request-merged']).sort()).toEqual([
      'merge-request.created',
      'merge-request.merged',
    ]);
  });

  it('folds tags the way the graph keys them', () => {
    expect(foldTags(['Billing', 'tag:billing', '  Безопасность ', ''])).toEqual(['billing', 'безопасность']);
  });
});

describe('ChatSubscriptionsService.deliver', () => {
  it('sends each row once: a second sweep with the same snapshot loses the claim', async () => {
    const h = harness({ rows: [row(1, {})], revisions: [rev('rev-1', 'd-1')] });
    const stale = h.snapshot();
    expect(await h.svc.deliver(stale as never, NOW)).toBe(true);
    // Another process read the rule before the cursor moved.
    expect(await h.svc.deliver(stale as never, NOW)).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it('resumes after a restart from where the cursor stopped, without skipping or repeating', async () => {
    const rows = [row(1, {}), row(2, { documentId: 'd-2', subjectId: 'rev-2' })];
    const h = harness({
      rows,
      revisions: [rev('rev-1', 'd-1'), rev('rev-2', 'd-2')],
      docs: [
        { id: 'd-1', title: 'Billing runbook' },
        { id: 'd-2', title: 'Refunds' },
      ],
    });
    await h.svc.deliver(h.snapshot() as never, NOW);
    expect(h.stored.cursorId).toBe(rows[1].id);

    // A new process, a new row in the same instant as the last one read.
    rows.push(row(3, { documentId: 'd-3', subjectId: 'rev-3', createdAt: rows[1].createdAt }));
    const after = harness({
      rows,
      revisions: [rev('rev-3', 'd-3')],
      docs: [{ id: 'd-3', title: 'Chargebacks' }],
      sub: {},
    });
    Object.assign(after.stored, { cursorAt: h.stored.cursorAt, cursorId: h.stored.cursorId });
    await after.svc.deliver(after.snapshot() as never, NOW);
    expect(after.sent.flatMap((v) => (v.kind === 'updates' ? v.items.map((i) => i.title) : []))).toEqual(['Chargebacks']);
  });

  it('never reads rows younger than the commit lag, and leaves them for the next tick', async () => {
    const young = row(1, { createdAt: ago(COMMIT_LAG_MS - 1000) });
    const h = harness({ rows: [young], revisions: [rev('rev-1', 'd-1')] });
    expect(await h.svc.deliver(h.snapshot() as never, NOW)).toBe(false);
    expect(h.stored.cursorId).toBe(ZERO);
  });

  it('holds the cursor before a tagged page still indexing, and sends what came before it', async () => {
    const h = harness({
      rows: [row(1, {}), row(2, { documentId: 'd-2', subjectId: 'rev-2' })],
      revisions: [rev('rev-1', 'd-1'), rev('rev-2', 'd-2', { status: 'indexing' })],
      docs: [
        { id: 'd-1', title: 'Billing runbook' },
        { id: 'd-2', title: 'Invoices' },
      ],
      tagged: ['d-1', 'd-2'],
      sub: { tags: ['billing'] },
    });
    await h.svc.deliver(h.snapshot() as never, NOW);
    expect(h.stored.cursorId).toBe(row(1, {}).id);
    expect(h.sent).toHaveLength(1);
  });

  it('stops waiting for indexing after a while and judges on the tags the graph has', async () => {
    const old = row(1, { createdAt: ago(INDEX_WAIT_MS + 60_000) });
    const h = harness({
      rows: [old],
      revisions: [rev('rev-1', 'd-1', { status: 'finalized' })],
      tagged: [],
      sub: { tags: ['billing'] },
    });
    h.stored.cursorAt = ago(INDEX_WAIT_MS + 120_000);
    await h.svc.deliver(h.snapshot() as never, NOW);
    expect(h.stored.cursorId).toBe(old.id);
    expect(h.sent).toHaveLength(0);
  });

  it('puts the cursor back and records why when the platform refuses the send', async () => {
    const h = harness({ rows: [row(1, {})], revisions: [rev('rev-1', 'd-1')], sendFails: true });
    await expect(h.svc.deliver(h.snapshot() as never, NOW)).rejects.toThrow(/kicked/);
    expect(h.stored.cursorId).toBe(ZERO);
    expect(h.stored.lastError).toMatch(/kicked/);
  });

  it('asks the graph for tags inside the rule’s workspace and drops untagged and foreign pages', async () => {
    const h = harness({
      rows: [
        row(1, {}),
        row(2, { documentId: 'd-2', subjectId: 'rev-2' }),
        row(3, { documentId: 'd-x', subjectId: 'rev-3' }),
      ],
      revisions: [rev('rev-1', 'd-1'), rev('rev-2', 'd-2'), rev('rev-3', 'd-x')],
      docs: [
        { id: 'd-1', title: 'Billing runbook' },
        { id: 'd-2', title: 'Lunch menu' },
        { id: 'd-x', title: 'Someone else’s billing', workspaceId: OTHER_WS },
      ],
      tagged: ['d-1', 'd-x'],
      sub: { tags: ['Billing'] },
    });
    // The stored rule holds folded tags; pass them as the service stores them.
    h.stored.tags = foldTags(['Billing']);
    await h.svc.deliver(h.snapshot() as never, NOW);
    expect(h.graph.getDocumentIdsByTags).toHaveBeenCalledWith(WS, ['tag:billing']);
    expect(h.reads[0].workspaceId).toBe(WS);
    const view = h.sent[0];
    expect(view.kind === 'updates' && view.items.map((i) => i.title)).toEqual(['Billing runbook']);
  });

  it('ignores review branches, says "new page" for a first revision and folds repeated edits', async () => {
    const h = harness({
      rows: [
        row(1, {}),
        row(2, { subjectId: 'rev-2' }),
        row(3, { subjectId: 'rev-3' }),
        row(4, { documentId: 'd-2', subjectId: 'rev-4' }),
      ],
      revisions: [
        rev('rev-1', 'd-1'),
        rev('rev-2', 'd-1'),
        rev('rev-3', 'd-1', { branchId: 'b-draft', branch: { name: 'chat/abc' } }),
        rev('rev-4', 'd-2'),
      ],
      firsts: [{ id: 'rev-1', documentId: 'd-1', branchId: 'b-main' }],
      docs: [
        { id: 'd-1', title: 'Billing runbook' },
        { id: 'd-2', title: 'Refunds' },
      ],
    });
    await h.svc.deliver(h.snapshot() as never, NOW);
    const view = h.sent[0];
    expect(view.kind === 'updates' && view.items.map((i) => `${i.label}|${i.title}`)).toEqual([
      'chat.updates.kind.page-published|Billing runbook',
      'chat.updates.kind.page-updated|Refunds',
    ]);
  });

  it('lets a merged merge request say it rather than a second "updated" line', async () => {
    const h = harness({
      rows: [
        row(1, { subjectId: 'rev-m' }),
        row(2, { action: 'merge-request.merged', subjectId: 'mr-1', metadata: { title: 'Fix the refund window' } }),
      ],
      revisions: [rev('rev-m', 'd-1')],
      merged: ['rev-m'],
    });
    await h.svc.deliver(h.snapshot() as never, NOW);
    const view = h.sent[0];
    expect(view.kind === 'updates' && view.items).toEqual([
      { label: 'chat.updates.kind.merge-request-merged', title: 'Fix the refund window', url: 'https://kn.test/merge-requests/mr-1' },
    ]);
  });

  it('sends a title and a link, never the content a row carries', async () => {
    const h = harness({
      rows: [row(1, { action: 'merge-request.created', subjectId: 'mr-9', metadata: { title: 'Rotate keys', description: 'SECRET body' } })],
    });
    await h.svc.deliver(h.snapshot() as never, NOW);
    const out = new TelegramAdapter('https://api.telegram.org').render(h.sent[0]);
    expect(out.plain).toBe('chat.updates.kind.merge-request-opened: Rotate keys — https://kn.test/merge-requests/mr-9');
    expect(JSON.stringify(h.sent[0])).not.toContain('SECRET');
  });

  it('moves the cursor past rows it does not report, without sending anything', async () => {
    const h = harness({
      rows: [row(1, { subjectId: 'rev-1' })],
      revisions: [rev('rev-1', 'd-1', { branchId: 'b-x', branch: { name: 'feature' } })],
    });
    expect(await h.svc.deliver(h.snapshot() as never, NOW)).toBe(false);
    expect(h.stored.cursorId).toBe(row(1, {}).id);
    expect(h.adapter.postMessage).not.toHaveBeenCalled();
  });

  it('starts the next digest window on an empty one, and heads a digest with its scope', async () => {
    const empty = harness({ rows: [], sub: { delivery: 'digest', digestMinutes: 60 } });
    await empty.svc.deliver(empty.snapshot() as never, NOW);
    expect(empty.stored.nextDueAt).toEqual(new Date(NOW.getTime() + 3_600_000));

    const full = harness({ rows: [row(1, {})], revisions: [rev('rev-1', 'd-1')], sub: { delivery: 'digest', digestMinutes: 60 } });
    await full.svc.deliver(full.snapshot() as never, NOW);
    const view = full.sent[0];
    expect(view.kind === 'updates' && view.heading).toBe('chat.updates.digest');
    expect(full.stored.nextDueAt).toEqual(new Date(NOW.getTime() + 3_600_000));
  });
});

describe('Telegram updates rendering', () => {
  it('escapes titles and links them', () => {
    const out = new TelegramAdapter('https://api.telegram.org').render({
      kind: 'updates',
      heading: '2 updates in <Payments>',
      items: [{ label: 'New page', title: 'A <b>bold</b> & "quoted" page', url: 'https://kn.test/documents/d-1?a=1&b=2' }],
      more: '…and 1 more',
    });
    expect(out.text).toBe(
      '<b>2 updates in &lt;Payments&gt;</b>\nNew page: <a href="https://kn.test/documents/d-1?a=1&amp;b=2">A &lt;b&gt;bold&lt;/b&gt; &amp; "quoted" page</a>\n…and 1 more',
    );
  });
});
