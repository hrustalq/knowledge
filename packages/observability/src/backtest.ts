import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { BacktestEvent } from '@knowledge/contracts/observability';

/**
 * The measurement stream: one JSON object per line, one file per day.
 *
 * Separate from the diagnostic log on purpose. These are measurements, not
 * something anyone reads while debugging — a full corpus re-index emits tens of
 * thousands — so they go to a file a harness reads, rather than to stdout (which
 * would drown it) or to Postgres (which would carry the write amplification of a
 * transactional table for data nothing transactional reads).
 *
 * Until configureBacktest runs, and whenever it is configured off, every emit is
 * a no-op: a measurement stream must never be the reason a request fails.
 */
let stream: WriteStream | undefined;
let streamDay: string | undefined;
let dir = 'logs';
let enabled = false;
let dropped = 0;

export function configureBacktest(opts: { enabled: boolean; dir: string }): void {
  enabled = opts.enabled;
  dir = opts.dir;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function destination(): WriteStream | undefined {
  const day = today();
  if (stream && streamDay === day) return stream;
  try {
    mkdirSync(dir, { recursive: true });
    stream?.end();
    const next = createWriteStream(join(dir, `ops-${day}.jsonl`), { flags: 'a' });
    // An unhandled 'error' event on a stream takes the process down. Dropping
    // measurements is always preferable to that.
    next.on('error', () => {
      stream = undefined;
      streamDay = undefined;
      dropped += 1;
    });
    stream = next;
    streamDay = day;
    return stream;
  } catch {
    dropped += 1;
    return undefined;
  }
}

export function emitBacktest(event: BacktestEvent): void {
  if (!enabled) return;
  const out = destination();
  if (!out) return;
  try {
    out.write(`${JSON.stringify(event)}\n`);
  } catch {
    dropped += 1;
  }
}

/** Read by the ops surface rather than logged, so a failing stream cannot log its way into a loop. */
export function backtestDropped(): number {
  return dropped;
}

export function closeBacktest(): void {
  stream?.end();
  stream = undefined;
  streamDay = undefined;
}
