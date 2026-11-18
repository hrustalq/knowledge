import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type {
  AdminErrorGroup,
  AdminErrorOccurrence,
  AdminErrorResponse,
  AdminErrorsResponse,
  AdminErrorWorkspaceFacet,
  OpsProcessKind,
} from '@knowledge/contracts';
import type { Env } from '../config/env.js';
import { PrismaService } from '../prisma/prisma.service.js';

const PAGE = 50;
const RECENT = 20;
const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const QUOTED_PATTERN = `"[^"]*"|'[^']*'`;
const NUMBER_PATTERN = '0x[0-9a-f]+|[0-9]+';

/**
 * The one spelling of an error's fingerprint (#1240), over an `ops_events`
 * row aliased `e`: source, logger context, and the message plus the logged
 * error's own type and message, with ids, quoted values and numbers folded, so
 * "Document 3f… not found" repeats as one group. The error's own text counts
 * because a catch-all logs one sentence for everything (`ApiExceptionFilter`:
 * "Unhandled exception"), which alone would make every 500 one group.
 * Derived on every read, never stored: a better rule regroups history at once.
 */
export const FINGERPRINT_SQL = Prisma.sql`md5(e.source || '|' || coalesce(e.fields->>'ctx', '') || '|' ||
  regexp_replace(regexp_replace(regexp_replace(
    e.message || '|' || coalesce(e.fields->'err'->>'type', '') || '|' || coalesce(e.fields->'err'->>'message', ''),
    ${UUID_PATTERN}, '<id>', 'gi'), ${QUOTED_PATTERN}, '<s>', 'g'), ${NUMBER_PATTERN}, '<n>', 'gi'))`;

/** The logged error's message on one line, over the group's newest row `l`: what tells two catch-all groups apart. */
const DETAIL_SQL = Prisma.sql`nullif(left(regexp_replace(btrim(l.fields->'err'->>'message'), ${'\\s+'}, ' ', 'g'), 300), l.message)`;

/** Microseconds survive the round trip, so a keyset cursor never repeats or skips a group. */
const AT_US = (col: Prisma.Sql) => Prisma.sql`to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export interface ErrorFilter {
  hours: number;
  processes?: OpsProcessKind[];
  workspaceIds?: string[];
  /** Matches the message (contains, case-folded) or a trace id exactly. */
  text?: string;
  cursor?: string;
}

interface GroupRow {
  fp: string;
  latest_id: string;
  message: string;
  detail: string | null;
  level: string;
  code: string | null;
  source: string;
  context: string | null;
  route: string | null;
  processes: Array<OpsProcessKind | null>;
  count: number;
  workspace_count: number;
  first_seen: Date;
  last_seen: Date;
  cursor_at: string;
}

interface EventRow {
  id: string;
  created_at: Date;
  trace_id: string;
  process: OpsProcessKind | null;
  source: string;
  level: string;
  code: string | null;
  message: string;
  route: string | null;
  duration_ms: number | null;
  workspace_id: string | null;
  workspace_name: string | null;
  user_id: string | null;
  user_email: string | null;
  fields: Record<string, unknown> | null;
  fp: string;
}

/** The admin console's errors list (#1240): `ops_events`, read across every workspace. */
@Injectable()
export class AdminErrorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(filter: ErrorFilter): Promise<AdminErrorsResponse> {
    const since = Prisma.sql`e.created_at >= now() - make_interval(hours => ${filter.hours}::int)`;
    const where = [since];
    if (filter.processes?.length) where.push(Prisma.sql`e.process = ANY(${filter.processes}::text[])`);
    if (filter.workspaceIds?.length) where.push(Prisma.sql`e.workspace_id = ANY(${filter.workspaceIds}::uuid[])`);
    if (filter.text) {
      const like = `%${filter.text.replace(/[\\%_]/g, '\\$&')}%`;
      where.push(Prisma.sql`(e.message ILIKE ${like} OR e.trace_id = ${filter.text})`);
    }
    const [cursorAt, cursorFp] = filter.cursor?.split('~') ?? [];
    // The DTO checks the shape; a date that does not exist (month 13, 31 February) would fail the cast in SQL.
    const at = cursorAt ? new Date(cursorAt) : null;
    if (at && (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 23) !== cursorAt!.slice(0, 23))) {
      throw new BadRequestException({ statusCode: 400, message: 'Invalid cursor' });
    }
    const after = cursorAt && cursorFp ? Prisma.sql`WHERE (g.last_seen, g.fp) < (${cursorAt}::timestamptz, ${cursorFp})` : Prisma.empty;

    const [rows, workspaces] = await Promise.all([
      this.prisma.$queryRaw<GroupRow[]>`
        WITH m AS (
          SELECT e.id, e.created_at, e.workspace_id, e.process, ${FINGERPRINT_SQL} AS fp
            FROM ops_events e WHERE ${Prisma.join(where, ' AND ')}
        ), g AS (
          SELECT fp, count(*)::int AS count, count(DISTINCT workspace_id)::int AS workspace_count,
                 min(created_at) AS first_seen, max(created_at) AS last_seen,
                 (array_agg(id ORDER BY created_at DESC))[1] AS latest_id,
                 array_agg(DISTINCT process) AS processes
            FROM m GROUP BY fp
        )
        SELECT g.*, ${AT_US(Prisma.sql`g.last_seen`)} AS cursor_at,
               l.message, ${DETAIL_SQL} AS detail, l.level, l.code, l.source, l.fields->>'ctx' AS context, l.route
          FROM g JOIN ops_events l ON l.id = g.latest_id
          ${after}
         ORDER BY g.last_seen DESC, g.fp DESC
         LIMIT ${PAGE + 1}`,
      this.prisma.$queryRaw<Array<{ workspace_id: string; name: string; count: number }>>`
        SELECT e.workspace_id, w.name, count(*)::int AS count
          FROM ops_events e JOIN workspaces w ON w.id = e.workspace_id
         WHERE ${since}
         GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 100`,
    ]);

    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return {
      groups: page.map(toGroup),
      nextCursor: rows.length > PAGE && last ? `${last.cursor_at}~${last.fp}` : null,
      workspaces: workspaces.map((w): AdminErrorWorkspaceFacet => ({ workspaceId: w.workspace_id, name: w.name, count: w.count })),
      retentionDays: this.config.get('OPS_EVENTS_RETENTION_DAYS', { infer: true }),
      recording: this.config.get('OPS_SINK_ENABLED', { infer: true }),
    };
  }

  async get(id: string): Promise<AdminErrorResponse> {
    const [event] = await this.prisma.$queryRaw<EventRow[]>`
      SELECT e.id, e.created_at, e.trace_id, e.process, e.source, e.level, e.code, e.message, e.route, e.duration_ms,
             e.workspace_id, w.name AS workspace_name, e.user_id, u.email AS user_email, e.fields, ${FINGERPRINT_SQL} AS fp
        FROM ops_events e
        LEFT JOIN workspaces w ON w.id = e.workspace_id
        LEFT JOIN users u ON u.id = e.user_id
       WHERE e.id = ${id}::uuid`;
    if (!event) throw new NotFoundException({ statusCode: 404, message: 'Error event not found' });

    const fields = event.fields ?? {};
    // The fingerprint starts with the source and the context, so filtering on
    // both first keeps the regex off every other row.
    // ponytail: scans the group's source+context rows under retention; store the fingerprint if this gets slow
    const same = Prisma.sql`e.source = ${event.source} AND coalesce(e.fields->>'ctx', '') = ${typeof fields.ctx === 'string' ? fields.ctx : ''}
      AND ${FINGERPRINT_SQL} = ${event.fp}`;
    const [[group], recent] = await Promise.all([
      this.prisma.$queryRaw<Array<{ count: number; first_seen: Date; last_seen: Date }>>`
        SELECT count(*)::int AS count, min(e.created_at) AS first_seen, max(e.created_at) AS last_seen
          FROM ops_events e WHERE ${same}`,
      this.prisma.$queryRaw<EventRow[]>`
        SELECT e.id, e.created_at, e.trace_id, e.process, e.workspace_id, w.name AS workspace_name, e.route
          FROM ops_events e LEFT JOIN workspaces w ON w.id = e.workspace_id
         WHERE ${same}
         ORDER BY e.created_at DESC LIMIT ${RECENT}`,
    ]);

    const err = fields.err as { stack?: unknown } | undefined;
    return {
      event: {
        id: event.id,
        createdAt: event.created_at.toISOString(),
        traceId: event.trace_id,
        process: event.process,
        source: event.source,
        level: event.level,
        code: event.code,
        message: event.message,
        context: typeof fields.ctx === 'string' ? fields.ctx : null,
        route: event.route,
        durationMs: event.duration_ms,
        workspaceId: event.workspace_id,
        workspaceName: event.workspace_name,
        userId: event.user_id,
        userEmail: event.user_email,
        stack: typeof err?.stack === 'string' ? err.stack : null,
        fields,
      },
      group: {
        fingerprint: event.fp,
        count: group?.count ?? 1,
        firstSeenAt: (group?.first_seen ?? event.created_at).toISOString(),
        lastSeenAt: (group?.last_seen ?? event.created_at).toISOString(),
      },
      recent: recent.map(
        (r): AdminErrorOccurrence => ({
          id: r.id,
          createdAt: r.created_at.toISOString(),
          traceId: r.trace_id,
          process: r.process,
          workspaceId: r.workspace_id,
          workspaceName: r.workspace_name,
          route: r.route,
        }),
      ),
    };
  }
}

function toGroup(r: GroupRow): AdminErrorGroup {
  return {
    fingerprint: r.fp,
    latestId: r.latest_id,
    message: r.message,
    detail: r.detail,
    level: r.level,
    code: r.code,
    source: r.source,
    context: r.context,
    route: r.route,
    processes: r.processes,
    count: r.count,
    workspaceCount: r.workspace_count,
    firstSeenAt: r.first_seen.toISOString(),
    lastSeenAt: r.last_seen.toISOString(),
  };
}
