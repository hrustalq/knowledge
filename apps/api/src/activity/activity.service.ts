import { Injectable, Logger } from '@nestjs/common';
import type {
  ActivityCalendarDay,
  ActivityCalendarResponse,
  ActivityEntry,
  ActivityKind,
  ListActivityResponse,
} from '@knowledge/contracts';
import { ACTIVITY_KINDS, activityKindFor, FRESHNESS_ACTIONS } from '@knowledge/contracts';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { hidesAnything, visibilitySql, type AccessScope } from '../permissions/access-scope.js';
import { actorIdentities, DEV_ACTOR } from './actor.js';
import { EventsPublisher } from '../events/events.publisher.js';

export interface ActivityRecordInput {
  workspaceId: string;
  /** users.id, or the synthetic dev actor when omitted. */
  actor?: string;
  /** e.g. 'document.created', 'revision.finalized', 'merge-request.merged'. */
  action: string;
  documentId?: string;
  /**
   * The project this happened in. Optional because most callers already hold
   * the document and `record` can resolve it — pass it to skip that read.
   */
  projectId?: string;
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
      const projectId = input.projectId ?? (await this.projectOf(input));
      await this.prisma.activityLog.create({
        data: {
          workspaceId: input.workspaceId,
          actor: input.actor ?? DEV_ACTOR,
          action: input.action,
          documentId: input.documentId ?? null,
          projectId,
          subjectId: input.subjectId ?? null,
          metadata: (input.metadata ?? {}) as object,
        },
      });
      // A page's freshness clock (docs/features/39), bumped here rather than at
      // each call site so a new writer cannot forget it. The set is the same
      // one the migration backfilled from, so "inactive" means one thing.
      if (input.documentId && FRESHNESS_ACTIONS.has(input.action)) {
        await this.prisma.document.updateMany({
          where: { id: input.documentId },
          data: { lastActivityAt: new Date() },
        });
      }
      await this.events.publish({
        type: input.action,
        workspaceId: input.workspaceId,
        documentId: input.documentId,
        subjectId: input.subjectId,
        actor: input.actor ?? DEV_ACTOR,
        title: typeof input.metadata?.title === 'string' ? input.metadata.title : undefined,
        ...(input.patch ? { patch: input.patch } : {}),
      });
    } catch (e) {
      this.logger.warn(`Activity record failed (non-fatal): ${(e as Error).message}`);
    }
  }

  /**
   * Which project a row belongs to, when the caller did not say.
   *
   * Denormalized at write time rather than joined at read time, because the
   * question a project page asks — "what happened here, newest first, paged" —
   * is an index scan with the column and a join through every page the project
   * owns without it.
   *
   * One indexed point-select on a path that is already fire-and-forget and
   * already writing a row. Callers that hold the document pass `projectId` and
   * skip even that. Resolving here rather than at ~30 call sites also means a
   * new one cannot forget: a row filed under no project is invisible on the page
   * that exists to show it.
   *
   * `project.*` actions carry the project in `subjectId` and have no document,
   * which is the second branch.
   */
  private async projectOf(input: ActivityRecordInput): Promise<string | null> {
    if (input.documentId) {
      const doc = await this.prisma.document.findUnique({
        where: { id: input.documentId },
        select: { projectId: true },
      });
      return doc?.projectId ?? null;
    }
    if (input.subjectId && input.action.startsWith('project.')) return input.subjectId;
    return null;
  }

  /**
   * One page of the feed, newest first, as `scope`'s holder may read it.
   *
   * The page is chosen in SQL, visibility included (#76): a row about a page
   * the caller cannot open is filtered by the same predicate every list uses,
   * so the cursor (the last row's id, as before) stays stable and a page of
   * results is never short because rows were dropped in Node.
   */
  async list(
    workspaceId: string,
    opts: ActivityFilter & { limit?: number; cursor?: string },
    scope: AccessScope,
  ): Promise<ListActivityResponse> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const conditions = this.conditionsFor(workspaceId, opts, scope);
    if (opts.cursor) {
      // `(created_at, id)` rather than `created_at` alone: two rows in the same
      // millisecond would otherwise straddle a page boundary twice or never.
      conditions.push(Prisma.sql`(a."created_at", a."id") < (
        SELECT c."created_at", c."id" FROM "activity_log" c WHERE c."id" = ${opts.cursor}::uuid)`);
    }
    const picked = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT a."id" FROM "activity_log" a
       WHERE ${Prisma.join(conditions, ' AND ')}
       ORDER BY a."created_at" DESC, a."id" DESC
       LIMIT ${limit + 1}`;
    const hasMore = picked.length > limit;
    const ids = (hasMore ? picked.slice(0, limit) : picked).map((r) => r.id);
    const byId = new Map(
      (ids.length ? await this.prisma.activityLog.findMany({ where: { id: { in: ids } } }) : []).map((r) => [r.id, r]),
    );
    const page = ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });

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
    return { workspaceId, entries, nextCursor: hasMore ? ids[ids.length - 1] : null };
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
    scope: AccessScope,
  ): Promise<ActivityCalendarResponse> {
    const rows = await this.prisma.$queryRaw<{ action: string; createdAt: Date }[]>`
      SELECT a."action", a."created_at" AS "createdAt" FROM "activity_log" a
       WHERE ${Prisma.join(this.conditionsFor(workspaceId, opts, scope), ' AND ')}`;

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
   * Shared WHERE over `activity_log a`. Actors match exactly, never by
   * prefix: a profile that showed a stranger's rows because two ids share
   * eight characters would be worse than showing none.
   *
   * Visibility (#76): a row about a page the caller cannot open is left out,
   * metadata and all. A row about a page that is gone stays, as it did. A
   * guest, who reads nothing they were not granted, sees only rows about a page
   * they can open — never the workspace-level ones (settings, connectors).
   */
  private conditionsFor(workspaceId: string, opts: ActivityFilter, scope: AccessScope): Prisma.Sql[] {
    const where: Prisma.Sql[] = [Prisma.sql`a."workspace_id" = ${workspaceId}::uuid`];
    if (opts.documentId) where.push(Prisma.sql`a."document_id" = ${opts.documentId}::uuid`);
    if (opts.projectId) where.push(Prisma.sql`a."project_id" = ${opts.projectId}::uuid`);
    if (opts.subjectId) where.push(Prisma.sql`a."subject_id" = ${opts.subjectId}::uuid`);
    if (opts.actor) where.push(Prisma.sql`a."actor" = ANY(${actorIdentities(opts.actor)}::text[])`);
    if (opts.from) where.push(Prisma.sql`a."created_at" >= ${opts.from}`);
    if (opts.to) where.push(Prisma.sql`a."created_at" <= ${opts.to}`);
    if (scope.guest && !scope.bypass) {
      where.push(Prisma.sql`EXISTS (SELECT 1 FROM "documents" d
        WHERE d."id" = a."document_id" AND ${visibilitySql(scope, 'd')})`);
    } else if (hidesAnything(scope)) {
      where.push(Prisma.sql`NOT EXISTS (SELECT 1 FROM "documents" d
        WHERE d."id" = a."document_id" AND NOT (${visibilitySql(scope, 'd')}))`);
    }
    return where;
  }
}

export interface ActivityFilter {
  documentId?: string;
  projectId?: string;
  subjectId?: string;
  /** users.id, or 'dev'. Exact match, widened only by `actorIdentities`. */
  actor?: string;
  from?: Date;
  to?: Date;
}

// Re-exported from a leaf module so `EventsPublisher`'s notification fan-out
// can share them without closing an import cycle back through this file.
export { actorIdentities, DEV_ACTOR, DEV_ACTOR_ID, isDevActor } from './actor.js';

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
