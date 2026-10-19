import { Prisma } from '@prisma/client';
import { channelsForTrafficClass } from '@knowledge/contracts';

/** A person reading in the app. What "read" means in every health and analytics list (#79). */
export const HUMAN_CHANNELS = channelsForTrafficClass('human');

/**
 * Joins `documents <doc>` to what analytics knows about its reads (#79): the
 * page's newest human view as `lr`, and `sf` when a search returned it since
 * `since`. One grouped scan of each table, so the cost does not grow with the
 * number of pages listed. The aliases `lr` and `sf` are taken.
 */
export function readSignalsJoinSql(workspaceId: string, doc: string, since: Date): Prisma.Sql {
  const d = Prisma.raw(doc);
  return Prisma.sql`
    LEFT JOIN (
      SELECT document_id, max(created_at) AS last_read_at FROM page_views
       WHERE workspace_id = ${workspaceId}::uuid AND channel IN (${Prisma.join(HUMAN_CHANNELS)})
       GROUP BY document_id
    ) lr ON lr.document_id = ${d}.id
    LEFT JOIN (
      SELECT DISTINCT jsonb_array_elements_text(result_doc_ids) AS document_id FROM search_queries
       WHERE workspace_id = ${workspaceId}::uuid AND created_at >= ${since}::timestamptz
    ) sf ON sf.document_id = ${d}.id::text`;
}

/**
 * The columns `quietPageSql` reads, for the SELECT list over the join above.
 * `reads_covered` is whether collection began before `since` — before that,
 * "no read since" would be a gap in the data dressed as a fact.
 */
export function readSignalsColumnsSql(workspaceId: string, since: Date): Prisma.Sql {
  return Prisma.sql`lr.last_read_at, (sf.document_id IS NOT NULL) AS surfaced,
    COALESCE((SELECT min(created_at) FROM page_views WHERE workspace_id = ${workspaceId}::uuid) <= ${since}::timestamptz, false) AS reads_covered`;
}

/**
 * The one predicate behind `unread` and `dead`, over a row carrying
 * `created_at` and the columns above — knowledge health's filters and the
 * project dashboard's lists read the same clause, so they cannot disagree.
 * Unread: older than the window and no human view in it. Dead: also returned
 * by no search in it.
 */
export function quietPageSql(row: string, since: Date, kind: 'unread' | 'dead'): Prisma.Sql {
  const r = Prisma.raw(row);
  const unread = Prisma.sql`${r}.reads_covered AND ${r}.created_at < ${since}::timestamptz
    AND (${r}.last_read_at IS NULL OR ${r}.last_read_at < ${since}::timestamptz)`;
  return kind === 'dead' ? Prisma.sql`${unread} AND NOT ${r}.surfaced` : unread;
}
