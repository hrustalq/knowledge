/**
 * The bi-temporal model of the graph (#81), Nest-free so it is testable alone.
 *
 * Valid time (what the knowledge base said, and when) is never guessed: a
 * revision-scoped row is valid from its revision's `finalized_at` until the
 * next default-branch revision's `finalized_at`. Both instants are PG facts,
 * so the stamp is a pure function of the revision list — whichever order the
 * ingestion jobs finish in, re-stamping converges on the same intervals, and
 * the backfill is the same function run over every revision.
 *
 * System time (what we believed, and when) is `ingestedAt` / `expiredAt` on
 * edges: a re-extraction that drops a fact, or a person retracting one,
 * expires the row instead of deleting it.
 */

import type { ResolvedAsOf } from '@knowledge/contracts';

export type Lineage = 'default' | 'branch';

/** A revision as the stamp needs it. */
export interface StampableRevision {
  id: string;
  branchId: string | null;
  finalizedAt: Date | null;
}

/** The valid-time stamp of one revision's chunks and revision-scoped edges. */
export interface RevisionStamp {
  revisionId: string;
  /** Epoch ms; null on a branch lineage, which is never valid in the KB. */
  validFrom: number | null;
  /** Epoch ms; null while the revision is the newest on the default branch. */
  validTo: number | null;
  lineage: Lineage;
}

/**
 * Every finalized revision's stamp. The default branch's history is the
 * sequence of its finalized revisions in `finalized_at` order — the head moves
 * on finalize, and a merge finalizes a new revision on the target — so each one
 * is valid until the next. A legacy revision with no branch id belongs to the
 * default branch. Drafts are not stamped: they were never anyone's content.
 */
export function revisionStamps(revisions: readonly StampableRevision[], defaultBranchId: string | null): RevisionStamp[] {
  const finalized = revisions.filter((r): r is StampableRevision & { finalizedAt: Date } => r.finalizedAt !== null);
  const onDefault = (r: StampableRevision) => r.branchId === null || r.branchId === defaultBranchId;
  const chain = finalized
    .filter(onDefault)
    .sort((a, b) => a.finalizedAt.getTime() - b.finalizedAt.getTime() || a.id.localeCompare(b.id));
  const stamps: RevisionStamp[] = chain.map((r, i) => ({
    revisionId: r.id,
    validFrom: r.finalizedAt.getTime(),
    validTo: chain[i + 1]?.finalizedAt.getTime() ?? null,
    lineage: 'default',
  }));
  for (const r of finalized) {
    if (!onDefault(r)) stamps.push({ revisionId: r.id, validFrom: null, validTo: null, lineage: 'branch' });
  }
  return stamps;
}

/**
 * The stamps a job that just wrote `revisionId` must rewrite: its own, and on
 * the default branch its neighbours' — the one before it closes at its
 * `finalized_at`, the one after may have indexed first. Rewriting the window
 * from a fresh PG read is what makes out-of-order jobs converge.
 */
export function stampWindow(stamps: readonly RevisionStamp[], revisionId: string): RevisionStamp[] {
  const chain = stamps.filter((s) => s.lineage === 'default');
  const i = chain.findIndex((s) => s.revisionId === revisionId);
  if (i < 0) return stamps.filter((s) => s.revisionId === revisionId);
  return chain.slice(Math.max(0, i - 1), i + 2);
}

/** An edge row of one revision and extractor, as the reindex diff reads it. */
export interface ExistingFactRow {
  type: string;
  targetKey: string;
  expiredAt: number | null;
}

/**
 * A re-extraction of a revision already in the graph, by `(type, targetKey)`:
 * rows asserted again are kept (and refreshed in place), rows the extractor no
 * longer produces are expired — the page did not change, our belief did — and
 * facts with no current row are created. Already-expired rows are history and
 * never revived; a fact that comes back gets a new row with a new `ingestedAt`.
 */
export function diffRevisionFacts<F extends { type: string; target: { key: string } }>(
  existing: readonly ExistingFactRow[],
  incoming: readonly F[],
): { keep: F[]; expire: ExistingFactRow[]; create: F[] } {
  const key = (type: string, targetKey: string) => `${type} ${targetKey}`;
  const open = new Map(existing.filter((r) => r.expiredAt === null).map((r) => [key(r.type, r.targetKey), r]));
  const wanted = new Map(incoming.map((f) => [key(f.type, f.target.key), f]));
  return {
    keep: [...wanted].filter(([k]) => open.has(k)).map(([, f]) => f),
    expire: [...open].filter(([k]) => !wanted.has(k)).map(([, r]) => r),
    create: [...wanted].filter(([k]) => !open.has(k)).map(([, f]) => f),
  };
}

/** A resolved "as of" (#81): the instants a read uses, and what the caller asked for. */
export interface TemporalPoint {
  /** Valid time, epoch ms: what the knowledge base said at this instant. */
  at: number;
  /** System time, epoch ms: what was believed then. Null = now. */
  knownAt: number | null;
  resolved: ResolvedAsOf;
}

/**
 * The as-of predicate for an edge row — the only one (#81). Both instants are
 * bound parameters; `scopedSql` is the caller's revision-scoped extractor
 * list. A row is visible at `at` when it lies on the default lineage and its
 * interval covers `at`, and at `knownAt` when it had been written and not yet
 * retracted. Document-level rows written before #81 carry no stamps at all;
 * they read as valid all along, the only honest default for a claim with no
 * recorded start. Unstamped revision-scoped rows read as absent until the
 * backfill reaches them.
 */
export function asOfEdgeClause(point: TemporalPoint, scopedSql: string): { sql: string; params: { asOfAt: number; asOfKnown: number } } {
  return {
    sql:
      '(validTo IS NULL OR validTo > :asOfAt)' +
      ` AND ((lineage = 'default' AND validFrom <= :asOfAt) OR (lineage IS NULL AND validFrom IS NULL AND NOT (${scopedSql})))` +
      ' AND (ingestedAt IS NULL OR ingestedAt <= :asOfKnown) AND (expiredAt IS NULL OR expiredAt > :asOfKnown)',
    params: { asOfAt: point.at, asOfKnown: point.knownAt ?? Date.now() },
  };
}

/** An edge row's interval, as the timeline reads it. */
export interface FactIntervalRow {
  documentId: string;
  type: string;
  targetKey: string;
  validFrom: number | null;
  validTo: number | null;
}

/**
 * Per-day counts of facts that became valid and stopped being valid inside
 * `[from, to)`. Rows are per revision, so a fact a page keeps asserting
 * closes on one row at the very instant it opens on the next; those pairs
 * cancel, or every edit would read as every fact churning.
 */
export function factChangeDays(rows: readonly FactIntervalRow[], from: number, to: number): Array<{ day: string; opened: number; closed: number }> {
  const key = (r: FactIntervalRow, t: number) => `${r.documentId} ${r.type} ${r.targetKey} ${t}`;
  const opens = new Set<string>();
  const closes = new Set<string>();
  for (const r of rows) {
    if (r.validFrom !== null) opens.add(key(r, r.validFrom));
    if (r.validTo !== null) closes.add(key(r, r.validTo));
  }
  const days = new Map<string, { opened: number; closed: number }>();
  const bump = (t: number, field: 'opened' | 'closed') => {
    if (t < from || t >= to) return;
    const day = new Date(t).toISOString().slice(0, 10);
    const d = days.get(day) ?? { opened: 0, closed: 0 };
    d[field] += 1;
    days.set(day, d);
  };
  for (const k of opens) if (!closes.has(k)) bump(Number(k.slice(k.lastIndexOf(' ') + 1)), 'opened');
  for (const k of closes) if (!opens.has(k)) bump(Number(k.slice(k.lastIndexOf(' ') + 1)), 'closed');
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, c]) => ({ day, ...c }));
}

/** A response with the as-of echo added when a point applied (#81). */
export function withAsOf<T extends object>(response: T, at: TemporalPoint | undefined): T & { resolvedAsOf?: ResolvedAsOf } {
  return at ? { ...response, resolvedAsOf: at.resolved } : response;
}
