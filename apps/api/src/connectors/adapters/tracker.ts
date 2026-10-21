import type { Connector } from '@prisma/client';
import { workItemStatusMap } from '@knowledge/contracts';
import type {
  ConnectorWorkItemKind,
  ConnectorWorkItemState,
  TrackerKind,
  WorkItemStatus,
  WorkItemStatusMap,
} from '@knowledge/contracts';

/**
 * A tracker: the external system that owns a unit of work (#424).
 *
 * Beside `ConnectorAdapter`, never on it, for the reason feature 32 gave: that
 * interface moves *content*, and every verb here means something else. A
 * connector kind with `tasks: true` has one of these; which one is decided per
 * row (a repository connector's host picks GitHub or GitLab).
 *
 * Every method throws on a tracker refusal except where it says null: the
 * caller decides whether a failure is fatal (a person's handoff) or a retry (the
 * sweeper's transition).
 */
export interface TrackerIssue {
  kind: ConnectorWorkItemKind;
  /** The tracker's number: a GitHub/GitLab issue number, Jira's site-wide issue id. */
  number: number;
  /** How a person cites it when that is not `#number` (`BILL-123`). */
  externalKey: string | null;
  title: string;
  state: ConnectorWorkItemState;
  /** The raw status the connector's status map reads. */
  externalStatus: string | null;
  url: string;
  authorLogin: string | null;
  assigneeLogins: string[];
  labels: string[];
  /** Read only for the `knowledge-ref:` footer; never stored or shown. */
  body: string | null;
  externalCreatedAt: string | null;
  externalUpdatedAt: string | null;
}

/** Where on the tracker a new ticket goes, from the project's route. */
export interface TrackerCreateInput {
  title: string;
  /** The tracker's own body format is the adapter's business (Jira wants ADF). */
  lines: TrackerBodyLine[];
  labels: string[];
  /** Tracker logins; only the feature-32 create form sends them, never a handoff. */
  assignees?: string[];
  /** Jira project key; ignored by repository trackers. */
  externalProject?: string | null;
  /** Jira issue type; null = the adapter's default. */
  issueType?: string | null;
}

/** A body is three kinds of line, so no tracker needs a markdown converter. */
export type TrackerBodyLine = { text: string } | { link: string; text: string };

/** A board and its single-select status field, as a tracker route stores them. */
export interface TrackerBoard {
  nodeId: string;
  fieldId: string;
}

/** A ticket as the work-item row knows it. */
export interface TrackerRef {
  number: number;
  externalKey: string | null;
}

export interface TrackerAdapter {
  readonly kind: TrackerKind;
  /** Whether this adapter serves the row (kind and, for repositories, host). */
  supports(row: Connector): boolean;
  /**
   * Tickets changed since `since` (an ISO time, null = recent ones), oldest
   * change first so a cursor can advance past them. `cursor` is what to pass
   * next time; it never moves backwards. `watch` names the anchored tickets, for
   * a tracker too big to list whole (a Jira site): it lists those plus the
   * handoff label. A repository tracker lists the repository and ignores it,
   * and `labels` likewise: the labels a Jira site is searched by, the handoff
   * label and those ticket triggers filter on (#433).
   */
  listIssues(
    row: Connector,
    since: string | null,
    watch?: TrackerRef[],
    labels?: string[],
  ): Promise<{ items: TrackerIssue[]; cursor: string | null }>;
  /** Null when the ticket is gone or the credential cannot see it. */
  getIssue(row: Connector, ref: TrackerRef): Promise<TrackerIssue | null>;
  /** Read a person's `BILL-123` / `#45` / URL into a ref, or null when it is not one of this tracker's. */
  parseRef(row: Connector, text: string): TrackerRef | null;
  createIssue(row: Connector, input: TrackerCreateInput): Promise<TrackerIssue>;
  /** Move the ticket to a raw status; null when the ticket is gone. */
  transition(row: Connector, ref: TrackerRef, externalStatus: string): Promise<TrackerIssue | null>;
  comment(row: Connector, ref: TrackerRef, lines: TrackerBodyLine[]): Promise<void>;
  /** Board names per ticket number, for the trackers that have boards. Never throws. */
  boardsFor?(row: Connector, numbers: number[]): Promise<Map<number, string[]>>;
  /**
   * Put the ticket's card on a board and move it to the column for `status`
   * (GitHub Projects v2). Best effort: never throws, answers whether it moved.
   */
  setBoardStatus?(row: Connector, ref: TrackerRef, board: TrackerBoard, status: WorkItemStatus): Promise<boolean>;
  /** A board URL a person pasted, as the ids `setBoardStatus` needs. Throws a 400 a person can read. */
  resolveBoard?(row: Connector, url: string): Promise<TrackerBoard>;
  /**
   * A delivery on the connector's own webhook (`/v1/connectors/:id/webhook`):
   * null when the signature does not verify, `item: null` when it verified but
   * is not about a ticket. GitHub has no implementation: its deliveries come
   * through the App webhook.
   */
  verifyWebhook?(
    row: Connector,
    secret: string,
    headers: Record<string, string>,
    rawBody: string,
  ): { item: TrackerIssue | null; actorId: string | null } | null;
}

/** A connector's status map: `config.statusMap` layered over its tracker's default. */
export function statusMapFor(row: Pick<Connector, 'config'> | null, kind: TrackerKind): WorkItemStatusMap {
  const override = (row?.config as { statusMap?: Partial<WorkItemStatusMap> } | null)?.statusMap;
  return workItemStatusMap(kind, override && typeof override === 'object' ? override : null);
}

/**
 * The label a connector puts on handed-off tickets: `config.workItemLabel`,
 * else `knowledge`. No whitespace, which Jira labels cannot hold.
 */
export function labelFor(row: Pick<Connector, 'config'>): string {
  const label = (row.config as { workItemLabel?: unknown } | null)?.workItemLabel;
  const raw = typeof label === 'string' && label.trim() ? label.trim().slice(0, 50) : 'knowledge';
  return raw.replace(/\s+/g, '-');
}

/** Markdown for the trackers that take it (GitHub, GitLab). */
export function markdownBody(lines: TrackerBodyLine[]): string {
  return lines.map((l) => ('link' in l ? `[${l.text.replace(/[[\]]/g, '')}](${l.link})` : l.text)).join('\n\n');
}
