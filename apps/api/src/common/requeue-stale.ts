/** The stale predicate, read and written alike: still `running`, untouched since the cutoff. */
export type StaleWhere<K extends string> = { status: 'running' } & Record<K, { lt: Date }>;

/**
 * Recovers rows a dead worker left claimed (#809): every sweeper that re-queues
 * a stale `running` row goes through here, so none can drift from the rule.
 *
 * The rule is the house idempotency rule, a single guarded statement. The
 * reset carries the same predicate the read used, so a row that settled (or
 * was re-claimed) between the read and the write is left alone and nothing is
 * enqueued for it. A row that has used up its attempts is settled `failed`
 * rather than skipped: skipping it left it `running` forever, holding whatever
 * in-flight slot it occupied.
 *
 * The callers own the shapes — which column dates the claim, what a reset or a
 * failure writes, which job a retry gets — because those differ per model.
 */
export async function requeueStale<K extends string, R extends { id: string }>(opts: {
  /** The column that moves while a live worker holds the row. */
  staleField: K;
  staleMs: number;
  maxAttempts: number;
  /** Candidates, limited by the caller; `where` is the predicate to filter on. */
  find: (where: StaleWhere<K>) => Promise<R[]>;
  attemptOf: (row: R) => number;
  /** Back to the queue state. Must pass `where` through unchanged. */
  requeue: (where: StaleWhere<K> & { id: string }, row: R) => Promise<{ count: number }>;
  /** To `failed`. Must pass `where` through unchanged. */
  fail: (where: StaleWhere<K> & { id: string }, row: R) => Promise<{ count: number }>;
  /** Only for a row this call actually reset. */
  enqueue: (row: R) => Promise<void>;
}): Promise<{ requeued: R[]; failed: R[] }> {
  const stale = { status: 'running', [opts.staleField]: { lt: new Date(Date.now() - opts.staleMs) } } as StaleWhere<K>;
  const requeued: R[] = [];
  const failed: R[] = [];
  for (const row of await opts.find(stale)) {
    const where = { ...stale, id: row.id };
    if (opts.attemptOf(row) >= opts.maxAttempts) {
      if ((await opts.fail(where, row)).count === 1) failed.push(row);
    } else if ((await opts.requeue(where, row)).count === 1) {
      await opts.enqueue(row);
      requeued.push(row);
    }
  }
  return { requeued, failed };
}

/** The error a row exhausted by `requeueStale` is settled with. */
export function staleFailure(attempts: number): string {
  return `The worker stopped responding and the run used up its ${attempts} attempts.`;
}
