import { WORK_ITEM_SYNC_MAX_ATTEMPTS, type WorkItemStatus } from '@knowledge/contracts';

/**
 * Which side of a handoff moves (#424), as a pure function so the whole sync
 * contract can be tested without a tracker or a database.
 *
 * Nothing is pushed or pulled on a hook. The sweeper compares, each tick, what
 * the ticket says with what its anchor says, and the newer side wins
 * (last-writer-wins on our clock against the tracker's `updated_at`). That one
 * comparison covers both directions, a lost webhook, a lost event, and a
 * restart, because the state it reads is the state, not a message about it.
 */

/** What an anchor asks of its ticket. `status: null` is no opinion (a page, a superseded conflict). */
export interface AnchorState {
  status: WorkItemStatus | null;
  /** When the anchor last changed state. */
  at: Date;
}

export type SyncDecision =
  /** The ticket closed after the anchor last moved: resolve the anchor. */
  | { direction: 'inbound'; status: 'done' | 'wont_do' }
  /** The anchor moved after the ticket: transition the ticket. */
  | { direction: 'outbound'; status: WorkItemStatus }
  | null;

const closed = (s: WorkItemStatus) => s === 'done' || s === 'wont_do';

/**
 * Only open-versus-closed is a disagreement. `in_progress` against an open
 * anchor, or `done` against a dismissed one, is the tracker's detail.
 *
 * A ticket reopened after its anchor closed changes nothing here: a resolved
 * report and a closed conflict are final, and the reopen is the team's own
 * business on the tracker. A ticket with no `updated_at` loses to its anchor.
 */
export function syncDecision(ticket: { status: WorkItemStatus; at: Date | null }, anchor: AnchorState): SyncDecision {
  if (!anchor.status || closed(ticket.status) === closed(anchor.status)) return null;
  const ticketNewer = ticket.at !== null && ticket.at > anchor.at;
  if (ticketNewer) return closed(ticket.status) ? { direction: 'inbound', status: ticket.status as 'done' | 'wont_do' } : null;
  return { direction: 'outbound', status: anchor.status };
}

/**
 * After a failed outbound attempt: back off exponentially from the tick, and
 * give up into `failed` (a person's retry) after the fifth.
 */
export function afterFailure(attempts: number, now: Date, tickMs: number): { syncState: 'pending' | 'failed'; syncAttempts: number; nextSyncAt: Date | null } {
  const next = attempts + 1;
  if (next >= WORK_ITEM_SYNC_MAX_ATTEMPTS) return { syncState: 'failed', syncAttempts: next, nextSyncAt: null };
  return { syncState: 'pending', syncAttempts: next, nextSyncAt: new Date(now.getTime() + tickMs * 2 ** next) };
}
