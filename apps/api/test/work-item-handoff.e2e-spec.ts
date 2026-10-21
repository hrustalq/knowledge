import type { INestApplication } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { Connector } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEV_PRINCIPAL } from '../src/auth/principal.js';
import type { TrackerAdapter, TrackerBodyLine, TrackerCreateInput, TrackerIssue, TrackerRef } from '../src/connectors/adapters/tracker.js';
import { WorkItemHandoffService } from '../src/connectors/handoff/work-item-handoff.service.js';
import { WorkItemSyncSweeper } from '../src/connectors/handoff/work-item-sync.sweeper.js';
import { TrackerRegistry } from '../src/connectors/tracker-registry.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { createE2eApp } from './e2e-app.js';

/**
 * #424 phase 2, end to end against live infra (`make infra-up`): the real
 * handoff service, sweeper and anchors over Postgres, with an in-memory
 * tracker standing in for GitHub. Runs as the `AUTH_MODE=none` dev principal
 * in the demo workspace, on the first unrestricted page it finds; it removes
 * the connector, conflict and issue it creates.
 */

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

class MemoryTracker implements TrackerAdapter {
  readonly kind = 'github' as const;
  readonly tickets = new Map<number, TrackerIssue>();
  readonly transitions: string[] = [];
  readonly comments: string[] = [];
  failing = false;
  private next = 1;

  supports(): boolean {
    return true;
  }
  async listIssues(_row: Connector, since: string | null) {
    const items = [...this.tickets.values()].filter((t) => !since || (t.externalUpdatedAt ?? '') >= since);
    return { items, cursor: items.reduce((max, t) => (t.externalUpdatedAt! > max ? t.externalUpdatedAt! : max), since ?? '') || null };
  }
  async getIssue(_row: Connector, ref: TrackerRef) {
    return this.tickets.get(ref.number) ?? null;
  }
  parseRef(_row: Connector, text: string): TrackerRef | null {
    const m = /^#?(\d+)$/.exec(text);
    return m ? { number: Number(m[1]), externalKey: null } : null;
  }
  async createIssue(_row: Connector, input: TrackerCreateInput) {
    const number = this.next++;
    const body = input.lines.map((l) => l.text).join('\n');
    const ticket: TrackerIssue = {
      kind: 'issue', number, externalKey: null, title: input.title, state: 'open', externalStatus: 'open',
      url: `https://tracker.test/${number}`, authorLogin: 'bot', assigneeLogins: [], labels: input.labels, body,
      externalCreatedAt: new Date().toISOString(), externalUpdatedAt: new Date().toISOString(),
    };
    this.tickets.set(number, ticket);
    return ticket;
  }
  async transition(_row: Connector, ref: TrackerRef, raw: string) {
    if (this.failing) throw new Error('tracker said 502');
    this.transitions.push(raw);
    return this.set(ref.number, raw);
  }
  async comment(_row: Connector, _ref: TrackerRef, lines: TrackerBodyLine[]) {
    this.comments.push(lines.map((l) => l.text).join('\n'));
  }
  /** What a person on the tracker does. */
  set(number: number, raw: string): TrackerIssue {
    const ticket = this.tickets.get(number)!;
    // A second later than anything written so far, as a real clock would be.
    const at = new Date(Math.max(Date.now(), Date.parse(ticket.externalUpdatedAt!) + 1000) + 1000).toISOString();
    Object.assign(ticket, { externalStatus: raw, state: raw === 'open' ? 'open' : 'closed', externalUpdatedAt: at });
    return ticket;
  }
}

describe('tracker handoff (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let handoffs: WorkItemHandoffService;
  let sweeper: WorkItemSyncSweeper;
  const tracker = new MemoryTracker();
  let connector: Connector;
  let page: { id: string; projectId: string };
  const conflictId = randomUUID();
  const issueId = randomUUID();

  beforeAll(async () => {
    app = await createE2eApp();
    prisma = app.get(PrismaService);
    handoffs = app.get(WorkItemHandoffService);
    sweeper = app.get(WorkItemSyncSweeper);
    vi.spyOn(app.get(TrackerRegistry), 'trackerFor').mockReturnValue(tracker);

    const doc = await prisma.document.findFirst({
      where: { workspaceId: WORKSPACE, archivedAt: null, restrictedBy: { isEmpty: true } },
      include: { branches: true },
    });
    if (!doc) throw new Error('the demo workspace needs one unrestricted page');
    page = { id: doc.id, projectId: doc.projectId };
    const rev = doc.branches[0]?.headRevisionId ?? randomUUID();
    connector = await prisma.connector.create({
      data: {
        workspaceId: WORKSPACE, kind: 'markdown-git', name: `handoff-e2e-${randomUUID().slice(0, 8)}`,
        projectId: doc.projectId, config: { repoUrl: 'https://github.com/acme/app' },
      },
    });
    await prisma.knowledgeConflict.create({
      data: {
        id: conflictId, workspaceId: WORKSPACE, kind: 'doc-doc', fingerprint: createHash('sha256').update(conflictId).digest('hex'),
        aDocumentId: doc.id, aRevisionId: rev, aQuote: 'a', explanation: 'x', confidence: 0.9,
      },
    });
    await prisma.knowledgeIssue.create({
      data: { id: issueId, workspaceId: WORKSPACE, documentId: doc.id, kind: 'stale', detail: 'old', surface: 'web', createdBy: DEV_PRINCIPAL.userId },
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.knowledgeConflict.deleteMany({ where: { id: conflictId } });
    await prisma?.knowledgeIssue.deleteMany({ where: { id: issueId } });
    if (connector) await prisma.connector.delete({ where: { id: connector.id } }); // cascades its work items
    await app?.close();
  });

  const row = (sourceId: string) =>
    prisma.connectorWorkItem.findFirstOrThrow({ where: { connectorId: connector.id, sourceId } });

  it('hands off once per anchor, with summary, link, footer and label', async () => {
    const input = { workspaceId: WORKSPACE, sourceKind: 'conflict' as const, sourceId: conflictId, connectorId: connector.id };
    const first = await handoffs.handoff(DEV_PRINCIPAL, input);
    const again = await handoffs.handoff(DEV_PRINCIPAL, input);
    expect(again.id).toBe(first.id);
    expect(tracker.tickets.size).toBe(1);
    const ticket = tracker.tickets.get(first.number)!;
    expect(ticket.labels).toEqual(['knowledge']);
    expect(ticket.body).toContain(`knowledge-ref: conflict:${conflictId}`);
    expect(first).toMatchObject({ sourceKind: 'conflict', sourceId: conflictId, status: 'open', syncState: 'synced', key: `#${first.number}` });
  });

  it('dismisses the conflict when the ticket closes as not planned, by poll alone', async () => {
    const item = await row(conflictId);
    tracker.set(item.number, 'not_planned');
    await sweeper.pollOne(await prisma.connector.findUniqueOrThrow({ where: { id: connector.id } }), tracker);
    await sweeper.reconcile();
    const conflict = await prisma.knowledgeConflict.findUniqueOrThrow({ where: { id: conflictId } });
    expect(conflict.status).toBe('dismissed');
    // An unmapped closer is nobody here.
    expect(conflict.resolvedBy).toBeNull();
  });

  it('reopens the same ticket when the conflict is raised again, and closes it on resolve', async () => {
    await prisma.knowledgeConflict.update({ where: { id: conflictId }, data: { status: 'open', detectedAt: new Date(Date.now() + 5_000), resolvedAt: null } });
    await sweeper.reconcile();
    expect((await row(conflictId)).syncState).toBe('pending');
    await sweeper.push();
    expect(tracker.transitions).toEqual(['open']);
    expect(tracker.comments.at(-1)).toMatch(/raised again/i);
    expect(tracker.tickets.size).toBe(1);

    await prisma.knowledgeConflict.update({ where: { id: conflictId }, data: { status: 'resolved', resolvedAt: new Date(Date.now() + 10_000) } });
    await sweeper.reconcile();
    await sweeper.push();
    expect(tracker.transitions).toEqual(['open', 'completed']);
    expect(await row(conflictId)).toMatchObject({ syncState: 'synced', state: 'closed', externalStatus: 'completed' });
    // The read-back is newer than the anchor: no echo.
    await sweeper.reconcile();
    expect((await row(conflictId)).syncState).toBe('synced');
  });

  it('resolves a reported issue from a tracker close', async () => {
    const info = await handoffs.handoff(DEV_PRINCIPAL, { workspaceId: WORKSPACE, sourceKind: 'issue', sourceId: issueId, connectorId: connector.id });
    tracker.set(info.number, 'completed');
    await sweeper.pollOne(await prisma.connector.findUniqueOrThrow({ where: { id: connector.id } }), tracker);
    await sweeper.reconcile();
    expect((await prisma.knowledgeIssue.findUniqueOrThrow({ where: { id: issueId } })).status).toBe('resolved');
  });

  it('gives up into failed after five attempts and keeps the tracker error', async () => {
    await prisma.knowledgeConflict.update({ where: { id: conflictId }, data: { status: 'open', detectedAt: new Date(Date.now() + 60_000), resolvedAt: null } });
    await sweeper.reconcile();
    tracker.failing = true;
    let now = new Date();
    for (let i = 0; i < 5; i++) {
      await sweeper.push(now);
      now = new Date(now.getTime() + 3_600_000);
    }
    tracker.failing = false;
    expect(await row(conflictId)).toMatchObject({ syncState: 'failed', syncError: 'tracker said 502', syncAttempts: 5 });

    const retried = await handoffs.retry(connector, (await row(conflictId)).id);
    expect(retried.syncState).toBe('pending');
    await sweeper.push();
    expect(tracker.transitions.at(-1)).toBe('open');
  });
});
