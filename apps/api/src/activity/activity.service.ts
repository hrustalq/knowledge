import { Injectable, Logger } from '@nestjs/common';
import type {
  ActivityCalendarDay,
  ActivityCalendarResponse,
  ActivityEntry,
  ActivityKind,
  ListActivityResponse,
} from '@knowledge/contracts';
import { ACTIVITY_KINDS, activityKindFor } from '@knowledge/contracts';
import { PrismaService } from '../prisma/prisma.service.js';
import { EventsPublisher } from '../events/events.publisher.js';

export interface ActivityRecordInput {
  workspaceId: string;
  /** users.id, or the synthetic dev actor when omitted. */
  actor?: string;
  /** e.g. 'document.created', 'revision.finalized', 'merge-request.merged'. */
  action: string;
  documentId?: string;
  subjectId?: string;
  metadata?: Record<string, unknown>;
  /** Live data patching: changed entity fields, forwarded verbatim on the event bus (never persisted to the feed). */
  patch?: Record<string, unknown>;
}

/**
 * Feature 10 activity stream (docs/features/10): user-facing feed, distinct
 * from the Phase 5 security audit log. Recording is fire-and-forget — a feed
 * write must never fail the user's request — and every record is also
 * published on the live-event bus so feeds update in real time.
 */
@Injectable()
export class ActivityService {
  private readonly logger = new Logger(ActivityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsPublisher,
  ) {}

  async record(input: ActivityRecordInput): Promise<void> {
    try {
      await this.prisma.activityLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: input.actor ?? 'dev',
          action: input.action,
          documentId: input.documentId ?? null,
          subjectId: input.subjectId ?? null,
          metadata: (input.metadata ?? {}) as object,
        },
      });
      await this.events.publish({
        type: input.action,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        subjectId: input.subjectId,
        actor: input.actor ?? 'dev',
        title: typeof input.metadata?.title === 'string' ? input.metadata.title : undefined,
        ...(input.patch ? { patch: input.patch } : {}),
      });
    } catch (e) {
      this.logger.warn(`Activity record failed (non-fatal): ${(e as Error).message}`);
    }
  }

  async list(
    workspaceId: string,
    opts: ActivityFilter & { limit?: number; cursor?: string } = {},
  ): Promise<ListActivityResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.activityLog.findMany({
      where: this.whereFor(workspaceId, opts),
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const docIds = [...new Set(page.map((r) => r.documentId).filter((id): id is string => !!id))];
    const docs = docIds.length
      ? await this.prisma.document.findMany({ where: { id: { in: docIds } }, select: { id: true, title: true } })
      : [];
    const titleById = new Map(docs.map((d) => [d.id, d.title]));

    const entries: ActivityEntry[] = page.map((r) => ({
      id: r.id,
      workspaceId: r.workspaceId,
      actor: r.actor,
      action: r.action,
      documentId: r.documentId,
      documentTitle: r.documentId ? (titleById.get(r.documentId) ?? null) : null,
      projectId: r.projectId,
      subjectId: r.subjectId,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
      createdAt: r.createdAt.toISOString(),
    }));
    return { workspaceId, entries, nextCursor: hasMore ? page[page.length - 1].id : null };
  }

  /**
   * Contribution calendar: one row per active day, aggregated in PG.
   *
   * `date_trunc('day', created_at)` is UTC, and the client renders UTC days —
   * a cell and the list it opens must agree on where a day ends, and only the
   * server can decide that once for everyone. Kind is derived here rather than
   * grouped in SQL because `activityKindFor` is the shared reading of an action
   * (see contracts); pushing it into SQL would fork it into a second table.
   */
  async calendar(
    workspaceId: string,
    opts: { actor: string; from: Date; to: Date },
  ): Promise<ActivityCalendarResponse> {
    const rows = await this.prisma.activityLog.findMany({
      where: {
        workspaceId,
        actor: { in: actorIdentities(opts.actor) },
        createdAt: { gte: opts.from, lte: opts.to },
      },
      select: { action: true, createdAt: true },
    });

    const byDate = new Map<string, ActivityCalendarDay>();
    const byKind = emptyKindTally();
    for (const row of rows) {
      const date = dayKey(row.createdAt);
      let day = byDate.get(date);
      if (!day) {
        day = { date, total: 0, byKind: emptyKindTally() };
        byDate.set(date, day);
      }
      const kind = activityKindFor(row.action);
      day.total += 1;
      day.byKind[kind] += 1;
      byKind[kind] += 1;
    }

    const days = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
    const active = new Set(days.map((d) => d.date));
    return {
      workspaceId,
      actor: opts.actor,
      from: dayKey(opts.from),
      to: dayKey(opts.to),
      days,
      total: rows.length,
      byKind,
      busiestDay: days.reduce((max, d) => Math.max(max, d.total), 0),
      currentStreak: streakEndingAt(active, opts.to),
      longestStreak: longestStreak(days),
    };
  }

  /**
   * Shared WHERE. Actors match exactly, never by prefix: a profile that showed
   * a stranger's rows because two ids share eight characters would be worse
   * than showing none.
   */
  private whereFor(workspaceId: string, opts: ActivityFilter) {
    return {
      workspaceId,
      ...(opts.documentId ? { documentId: opts.documentId } : {}),
      ...(opts.subjectId ? { subjectId: opts.subjectId } : {}),
      ...(opts.actor ? { actor: { in: actorIdentities(opts.actor) } } : {}),
      ...(opts.from || opts.to
        ? { createdAt: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } }
        : {}),
    };
  }
}

export interface ActivityFilter {
  documentId?: string;
  subjectId?: string;
  /** users.id, or 'dev'. Exact match, widened only by `actorIdentities`. */
  actor?: string;
  from?: Date;
  to?: Date;
}

/**
 * The AUTH_MODE=none actor has two spellings in this table and always has:
 * `ActivityService.record` falls back to the literal 'dev' when a call site
 * passes no actor, while the call sites that DO pass one hand over
 * `principal.userId`, which for the dev principal is the zeros stub. Both are
 * the same person, so a profile that picked one would silently under-report —
 * measurably: a real workspace here holds 270 rows under the stub and 23 under
 * 'dev'.
 *
 * Widening is deliberately limited to this one pair. Every other actor
 * resolves to itself, so no real user's rows can ever be folded into another's.
 */
export function actorIdentities(actor: string): string[] {
  return actor === DEV_ACTOR || actor === DEV_ACTOR_ID ? [DEV_ACTOR, DEV_ACTOR_ID] : [actor];
}

/** The literal `ActivityService.record` writes when a call site passes no actor. */
export const DEV_ACTOR = 'dev';
/** DEV_PRINCIPAL.userId — the same person, as an id. */
export const DEV_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

function emptyKindTally(): Record<ActivityKind, number> {
  return Object.fromEntries(ACTIVITY_KINDS.map((k) => [k, 0])) as Record<ActivityKind, number>;
}

/** UTC calendar day, `YYYY-MM-DD`. */
function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shiftDay(date: string, days: number): string {
  const at = new Date(`${date}T00:00:00.000Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/**
 * Days ending at the window's last day. Counted backwards from `to` rather
 * than from "today" so a historical window reports the streak it actually
 * contains instead of always reporting zero.
 */
function streakEndingAt(active: Set<string>, to: Date): number {
  let cursor = dayKey(to);
  let run = 0;
  while (active.has(cursor)) {
    run += 1;
    cursor = shiftDay(cursor, -1);
  }
  return run;
}

function longestStreak(days: ActivityCalendarDay[]): number {
  let best = 0;
  let run = 0;
  let previous: string | null = null;
  for (const day of days) {
    run = previous !== null && shiftDay(previous, 1) === day.date ? run + 1 : 1;
    previous = day.date;
    if (run > best) best = run;
  }
  return best;
}
