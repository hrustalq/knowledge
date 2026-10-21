import { describe, expect, it } from 'vitest';
import {
  WORK_ITEM_SYNC_MAX_ATTEMPTS,
  workItemStateFor,
  workItemStatusFor,
  workItemStatusMap,
  type WorkItemStatus,
} from '@knowledge/contracts';
import type { Connector } from '@prisma/client';
import { labelFor, markdownBody } from '../src/connectors/adapters/tracker.js';
import { GithubIssuesService, toWorkItem } from '../src/connectors/github/github-issues.service.js';
import { afterFailure, syncDecision, type AnchorState } from '../src/connectors/handoff/work-item-sync.js';

/**
 * Tracker handoff sync (#424), without a tracker or a database.
 *
 * The sweeper's whole contract is `syncDecision`: compare what the ticket says
 * with what its anchor says, and let the newer side win. The flow below drives
 * it the way the sweeper does — an in-memory tracker that records the
 * transitions it was asked for, and an anchor whose state a "person" changes —
 * through handoff, a close on the tracker, a re-raise here and a resolve here.
 */

const github = workItemStatusMap('github');

class FakeTracker {
  status = 'open';
  at = new Date('2026-10-21T10:00:00Z');
  readonly transitions: string[] = [];
  close(raw: 'completed' | 'not_planned', at: Date) {
    this.status = raw;
    this.at = at;
  }
  transition(raw: string, at: Date) {
    this.transitions.push(raw);
    this.status = raw;
    this.at = at;
  }
  derived(): WorkItemStatus {
    return workItemStatusFor({ state: this.status === 'open' ? 'open' : 'closed', externalStatus: this.status }, github);
  }
}

/** One sweeper tick for one row: inbound resolves the anchor, outbound moves the ticket. */
function tick(tracker: FakeTracker, anchor: AnchorState, now: Date): AnchorState {
  const decision = syncDecision({ status: tracker.derived(), at: tracker.at }, anchor);
  if (decision?.direction === 'inbound') return { status: decision.status, at: now };
  if (decision?.direction === 'outbound') tracker.transition(github.outbound[decision.status] as string, now);
  return anchor;
}

describe('handoff sync flow', () => {
  it('closes, re-raises and resolves across both sides without echo', () => {
    const tracker = new FakeTracker();
    // Handed off: an open conflict, an open ticket. Nothing to do.
    let anchor: AnchorState = { status: 'open', at: new Date('2026-10-21T09:59:00Z') };
    anchor = tick(tracker, anchor, new Date('2026-10-21T10:00:15Z'));
    expect(tracker.transitions).toEqual([]);

    // Closed on the tracker as not planned: the anchor is dismissed, once.
    tracker.close('not_planned', new Date('2026-10-21T11:00:00Z'));
    anchor = tick(tracker, anchor, new Date('2026-10-21T11:00:15Z'));
    expect(anchor.status).toBe('wont_do');
    anchor = tick(tracker, anchor, new Date('2026-10-21T11:00:30Z'));
    expect(tracker.transitions).toEqual([]);

    // Re-raised here (same fingerprint): the same ticket reopens.
    anchor = { status: 'open', at: new Date('2026-10-22T08:00:00Z') };
    anchor = tick(tracker, anchor, new Date('2026-10-22T08:00:15Z'));
    expect(tracker.transitions).toEqual(['open']);
    expect(tracker.derived()).toBe('open');

    // Resolved here: the ticket closes as completed, and the read-back does not echo.
    anchor = { status: 'done', at: new Date('2026-10-22T09:00:00Z') };
    anchor = tick(tracker, anchor, new Date('2026-10-22T09:00:15Z'));
    anchor = tick(tracker, anchor, new Date('2026-10-22T09:00:30Z'));
    expect(tracker.transitions).toEqual(['open', 'completed']);
    expect(anchor.status).toBe('done');
  });

  it('leaves a ticket reopened on the tracker alone: a resolved anchor is final', () => {
    const tracker = new FakeTracker();
    tracker.status = 'completed';
    const anchor: AnchorState = { status: 'done', at: new Date('2026-10-21T09:00:00Z') };
    tracker.transition('open', new Date('2026-10-21T12:00:00Z'));
    expect(syncDecision({ status: tracker.derived(), at: tracker.at }, anchor)).toBeNull();
  });

  it('has no opinion for a page anchor or a superseded conflict', () => {
    expect(syncDecision({ status: 'done', at: null }, { status: null, at: new Date() })).toBeNull();
  });

  it('treats in-progress against open, and done against dismissed, as agreement', () => {
    const at = new Date();
    expect(syncDecision({ status: 'in_progress', at }, { status: 'open', at })).toBeNull();
    expect(syncDecision({ status: 'done', at }, { status: 'wont_do', at })).toBeNull();
  });
});

describe('afterFailure', () => {
  it('backs off, then gives up into failed', () => {
    const now = new Date('2026-10-21T10:00:00Z');
    const first = afterFailure(0, now, 15_000);
    expect(first).toMatchObject({ syncState: 'pending', syncAttempts: 1 });
    expect(first.nextSyncAt!.getTime() - now.getTime()).toBe(30_000);
    expect(afterFailure(WORK_ITEM_SYNC_MAX_ATTEMPTS - 1, now, 15_000)).toEqual({
      syncState: 'failed',
      syncAttempts: WORK_ITEM_SYNC_MAX_ATTEMPTS,
      nextSyncAt: null,
    });
  });
});

describe('GitHub as a tracker', () => {
  const row = { kind: 'markdown-git', locale: 'en', config: { repoUrl: 'https://github.com/acme/app' } } as unknown as Connector;
  const service = new GithubIssuesService({} as never, {} as never);

  it('folds the close reason into the raw status', () => {
    const base = { number: 7, title: 't', state: 'closed', html_url: 'u' };
    expect(toWorkItem({ ...base, state_reason: 'not_planned' }).externalStatus).toBe('not_planned');
    expect(toWorkItem({ ...base, state_reason: 'completed' }).externalStatus).toBe('completed');
    expect(toWorkItem({ ...base, state: 'open' }).externalStatus).toBe('open');
    expect(workItemStateFor(workItemStatusFor(toWorkItem({ ...base, state_reason: 'not_planned' }), github))).toBe('closed');
  });

  it('reads a ticket reference on its own repository only', () => {
    expect(service.parseRef(row, '#45')).toEqual({ number: 45, externalKey: null });
    expect(service.parseRef(row, 'acme/app#45')).toEqual({ number: 45, externalKey: null });
    expect(service.parseRef(row, 'https://github.com/acme/app/issues/45')).toEqual({ number: 45, externalKey: null });
    expect(service.parseRef(row, 'other/app#45')).toBeNull();
    expect(service.parseRef(row, 'BILL-45')).toBeNull();
  });

  it('serves github.com repository connectors and nothing else', () => {
    expect(service.supports(row)).toBe(true);
    expect(service.supports({ ...row, config: { repoUrl: 'https://gitlab.com/acme/app' } } as never)).toBe(false);
    expect(service.supports({ ...row, kind: 'notion' } as never)).toBe(false);
  });
});

describe('ticket text', () => {
  it('writes summary, link and footer, and keeps brackets out of link text', () => {
    expect(
      markdownBody([
        { text: 'Two sources disagree.' },
        { link: 'https://kb/conflicts', text: 'Open [here]' },
        { text: 'knowledge-ref: conflict:abc' },
      ]),
    ).toBe('Two sources disagree.\n\n[Open here](https://kb/conflicts)\n\nknowledge-ref: conflict:abc');
    expect(labelFor({ config: {} })).toBe('knowledge');
    expect(labelFor({ config: { workItemLabel: ' docs ' } })).toBe('docs');
    expect(labelFor({ config: { workItemLabel: 'kb docs' } })).toBe('kb-docs');
  });
});
