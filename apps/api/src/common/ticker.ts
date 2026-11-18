import type { Logger } from '@nestjs/common';

/** One finished pass, as the admin console's monitoring view (#1238) shows it. */
export interface TickReport {
  /** The owner's Logger context: the sweeper's class name. */
  name: string;
  /** From `every`; null for a ticker only ever driven by hand. */
  intervalMs: number | null;
  /** When the pass finished (epoch ms). */
  at: number;
  ok: boolean;
  ms: number;
}

let report: ((tick: TickReport) => void) | undefined;

/**
 * Installs the one process-wide tick recorder (`OpsBeacon`). A process that
 * never installs one (specs, the MCP stdio process, the OpenAPI generator)
 * records nothing. The recorder must not throw: it runs in every pass's finally.
 */
export function reportTicksTo(fn: ((tick: TickReport) => void) | undefined): void {
  report = fn;
}

/**
 * The one fixed tick (#820). There is no cron in this repo: scheduled work is
 * a due check inside a fixed interval, with back-pressure, so a slow pass
 * never stacks a second one on top of itself.
 *
 * `every` owns the interval, `stop` the shutdown, and `exclusive` the
 * back-pressure and the non-fatal catch. A sweeper keeps its public `sweep()`
 * (specs call it directly) and wraps its body in `exclusive`, so a direct call
 * and a timer call share the same in-flight flag.
 */
export class Ticker {
  private timer?: NodeJS.Timeout;
  private busy = false;
  private intervalMs: number | null = null;
  private readonly name: string;

  constructor(private readonly logger: Logger) {
    // Every sweeper builds its Logger with its class name; Nest keeps that
    // context protected, and reading it here spares 44 call sites a second argument.
    this.name = (logger as unknown as { context?: string }).context ?? 'Ticker';
  }

  /**
   * Calls `fn` every `ms`. The timer is unref'd, so it never holds a process
   * open — unless `keepAlive`, for a process whose only work is this tick.
   */
  every(ms: number, fn: () => unknown, { keepAlive = false } = {}): void {
    this.intervalMs = ms;
    this.timer = setInterval(() => void fn(), ms);
    if (!keepAlive) this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /** Runs `fn` unless a pass is in flight. A busy or failed pass returns `idle`; a failure is logged, never thrown. */
  exclusive(fn: () => Promise<void>): Promise<void>;
  exclusive<T>(fn: () => Promise<T>, idle: T): Promise<T>;
  async exclusive<T>(fn: () => Promise<T>, idle?: T): Promise<T | undefined> {
    if (this.busy) return idle;
    this.busy = true;
    const started = Date.now();
    let ok = true;
    try {
      return await fn();
    } catch (error) {
      ok = false;
      this.logger.warn(`tick failed (non-fatal): ${(error as Error)?.message ?? String(error)}`);
      return idle;
    } finally {
      this.busy = false;
      const at = Date.now();
      report?.({ name: this.name, intervalMs: this.intervalMs, at, ok, ms: at - started });
    }
  }
}
