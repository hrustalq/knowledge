import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BacktestEvent } from '@knowledge/contracts/observability';
import { currentService, type ServiceName } from '@knowledge/observability/logger';

/**
 * `<repo root>/logs`, resolved from this file's own location — never from
 * process.cwd().
 *
 * cwd differs per process: the API starts in apps/api and the SSR server in
 * apps/web, so a cwd-relative default quietly produced one stream per app and
 * split every browser → SSR → API trace across two files. This module always
 * lives at packages/observability/src/, so the repo root is three levels up.
 */
function defaultDir(): string {
  return resolve(import.meta.dirname, '..', '..', '..', 'logs');
}

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
let dir: string | undefined;
let service: ServiceName | undefined;
let enabled = false;
let dropped = 0;

export function configureBacktest(opts: { enabled: boolean; dir?: string; service?: ServiceName }): void {
  enabled = opts.enabled;
  dir = opts.dir;
  service = opts.service;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function destination(): WriteStream | undefined {
  const day = today();
  if (stream && streamDay === day) return stream;
  try {
    const root = dir ?? defaultDir();
    mkdirSync(root, { recursive: true });
    stream?.end();
    // One file per service, not one shared file. Two processes appending to the
    // same file is only atomic for writes under PIPE_BUF, and a serialized stack
    // trace comfortably exceeds that — interleaved writes would corrupt exactly
    // the records worth keeping. One directory still means one glob and one grep.
    const next = createWriteStream(join(root, `ops-${service ?? currentService()}-${day}.jsonl`), { flags: 'a' });
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

/**
 * Where the stream is being written. Exported so the backtest harness reads the
 * same location the writers use rather than re-deriving it — two copies of this
 * rule would drift, and the failure mode is a harness that silently reports on
 * an empty directory.
 */
export function backtestDir(): string {
  return dir ?? defaultDir();
}

export function closeBacktest(): void {
  stream?.end();
  stream = undefined;
  streamDay = undefined;
}
