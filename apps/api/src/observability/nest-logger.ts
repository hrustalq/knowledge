import type { LoggerService } from '@nestjs/common';
import type { AppLogger } from '@knowledge/observability';
import { opsSink } from './ops-sink.service.js';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/**
 * Bridges Nest's LoggerService onto pino.
 *
 * This is the leverage in the whole change: installed with app.useLogger(), it
 * routes all 54 existing `new Logger(X.name)` declarations and their 101 call
 * sites through pino, picking up the trace context from the logger's mixin —
 * without editing any of them.
 *
 * It accepts both styles, so migration is incremental rather than a flag day:
 *
 *   this.logger.warn(`Indexing failed for ${id}: ${e.message}`)   // today
 *   this.logger.warn({ msg: 'Indexing failed', code: 'FULLTEXT_INDEX_FAILED', revisionId, err })
 *
 * The second gets queryable fields and, via the `err` serializer, a real stack.
 * The first keeps working unchanged — its ids stay inside the sentence.
 *
 * Note the object form carries `msg` inside the object rather than as a second
 * argument: Nest's own convention is (message, context), so a trailing string is
 * always the logger's context name. Accepting it as a pino-style message too
 * would make `logger.log(obj, 'Something')` ambiguous.
 */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly root: AppLogger) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('trace', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(level: Level, message: unknown, rest: unknown[]): void {
    // Nest's own convention: log/warn/debug/verbose are called as
    // (message, context) and error as (message, stack, context) — the trailing
    // string is the `new Logger(X.name)` name in both shapes.
    const params = [...rest];
    const context = typeof params[params.length - 1] === 'string' ? (params.pop() as string) : undefined;
    const fields: Record<string, unknown> = context ? { ctx: context } : {};

    // A leftover param on error() is the stack Nest extracted from the throw.
    const stack = params.find((p) => typeof p === 'string') as string | undefined;
    if (stack) fields.err = { message: String(message), stack };

    let msg: string;
    if (message instanceof Error) {
      fields.err = message;
      msg = message.message;
    } else if (message !== null && typeof message === 'object') {
      const { msg: inner, ...others } = message as Record<string, unknown>;
      Object.assign(fields, others);
      msg = typeof inner === 'string' ? inner : '';
    } else {
      msg = String(message);
    }

    this.root[level](fields, msg);

    // Errors go to Postgres as well as to stdout, so a failure is still findable
    // by trace id after the container that logged it is gone. Never awaited: the
    // sink buffers, and a logging call must not add latency to a failing request.
    if (level === 'error' || level === 'fatal') {
      opsSink()?.record({ level, message: msg, fields });
    }
  }
}
